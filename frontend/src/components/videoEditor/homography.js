/*
 * Plane homographies shared by Mockup Frame and the layer-box helpers of the effect
 * chain, Layer Mask, Depth Scan and Auto Fill. Row-major 3x3 arrays: (u, v, 1) -> (x, y, w),
 * frame uv = (x/w, y/w).
 *
 * Two box-uv conventions exist and are NOT interchangeable:
 *   - Mockup Frame: (0,0) = top-left, y DOWN (affineBoxHomography).
 *   - fx helpers (fxLocal/fxFrame): p = 0.5 + 0.5·(a, b) with frame = origin + axisX·a +
 *     axisY·b, i.e. y UP along the layer's local +y (fxAffineHomography, fxBoxHomographies).
 */

/* Row-major 3x3, box uv (y down) -> frame uv: (u, v, 1) -> (x, y, w), frame = (x/w, y/w).
   The affine two-axis frame every warp uses, as a homography (w == 1 everywhere). */
export function affineBoxHomography(box) {
  const [ox, oy] = box.origin;
  const [ax, ay] = box.axisX;
  const [bx, by] = box.axisY;
  // frame = origin + axisX * (2u - 1) + axisY * (1 - 2v)
  return [
    2 * ax, -2 * bx, ox - ax + bx,
    2 * ay, -2 * by, oy - ay + by,
    0, 0, 1,
  ];
}


/* Square -> quad homography (Heckbert). Corners are box uv (0,0), (1,0), (1,1), (0,1)
   in frame uv. Returns null when the quad is degenerate. */
export function squareToQuadHomography(c0, c1, c2, c3) {
  const [x0, y0] = c0; const [x1, y1] = c1; const [x2, y2] = c2; const [x3, y3] = c3;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let g = 0; let h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = x1 - x2; const dx2 = x3 - x2;
    const dy1 = y1 - y2; const dy2 = y3 - y2;
    const det = dx1 * dy2 - dx2 * dy1;
    if (!(Math.abs(det) > 1e-12)) return null;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  const H = [
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ];
  return H.every(Number.isFinite) ? H : null;
}


/* Apply a row-major homography to a box uv point: [x, y, w]. */
export function homographyApply(H, u, v) {
  return [
    H[0] * u + H[1] * v + H[2],
    H[3] * u + H[4] * v + H[5],
    H[6] * u + H[7] * v + H[8],
  ];
}


/* Inverse of a row-major 3x3, or null when singular. */
export function invertHomography(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-14)) return null;
  const inv = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  return inv.every(Number.isFinite) ? inv : null;
}


/* The fx-helper convention as a homography of the two-axis affine frame. */
export function fxAffineHomography(box) {
  const [ox, oy] = box.origin;
  const [ax, ay] = box.axisX;
  const [bx, by] = box.axisY;
  // frame = origin + axisX * (2p.x - 1) + axisY * (2p.y - 1)
  return [
    2 * ax, 2 * bx, ox - ax - bx,
    2 * ay, 2 * by, oy - ay - by,
    0, 0, 1,
  ];
}

export const IDENTITY_HOMOGRAPHY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const IDENTITY_BOX = { origin: [0.5, 0.5], axisX: [0.5, 0], axisY: [0, 0.5], sizePx: [1, 1] };

/* { H, Hi } for a layer box in the fx convention: the projective map when the box
   carries one (`fxHom`, fitted by computeLayerBox to the four projected corners), the
   affine frame otherwise; the identity for no box (adjustment scope = the whole frame). */
export function fxBoxHomographies(box) {
  const H = box?.fxHom || fxAffineHomography(box || IDENTITY_BOX);
  const Hi = invertHomography(H) || IDENTITY_HOMOGRAPHY;
  return { H, Hi };
}

/* Write the box into a material's uniforms: the affine pair every shader still reads
   for fxDir and the homography pair fxLocal/fxFrame map through. A material without
   the matrix uniforms (rig deform) just gets the affine part. */
export function setFxBoxUniforms(u, box) {
  const b = box || IDENTITY_BOX;
  u.uFxOrigin.value.set(b.origin[0], b.origin[1]);
  u.uFxAxisX.value.set(b.axisX[0], b.axisX[1]);
  u.uFxAxisY.value.set(b.axisY[0], b.axisY[1]);
  if (u.uFxHom && u.uFxHomInv) {
    const { H, Hi } = fxBoxHomographies(box);
    u.uFxHom.value.set(H[0], H[1], H[2], H[3], H[4], H[5], H[6], H[7], H[8]);
    u.uFxHomInv.value.set(Hi[0], Hi[1], Hi[2], Hi[3], Hi[4], Hi[5], Hi[6], Hi[7], Hi[8]);
  }
}

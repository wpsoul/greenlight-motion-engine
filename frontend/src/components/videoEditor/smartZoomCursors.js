// Smart Zoom: our own cursor art (PLANS/SCREEN_RECORDER_SMOOTH_MOTION_PLAN.md §3.5), drawn as vectors so it is sharp at
// any zoom. Lab-grade shapes for now (the recorder's Motion preview, the labs); Phase 3 replaces them with the final
// set. Every shape is drawn in a 24-unit box around its hotspot. A leaf: canvas 2D only.
function poly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const ink = (ctx, fill, stroke, lw) => {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
};

const SHAPES = {
  // hotspot = the tip
  arrow(ctx) {
    poly(ctx, [[0, 0], [0, 17.2], [4.1, 13.4], [6.9, 20], [9.9, 18.8], [7.2, 12.4], [12.6, 12.4]]);
    ink(ctx, '#111', '#fff', 2.2);
  },
  // hotspot = the index fingertip
  pointingHand(ctx) {
    ctx.beginPath();
    ctx.moveTo(-1.6, 1.6);
    ctx.arc(0, 1.6, 1.6, Math.PI, 0);
    ctx.lineTo(1.6, 8.2);
    ctx.arc(3.6, 8.6, 1.5, Math.PI, 0);
    ctx.arc(6.6, 9.2, 1.5, Math.PI, 0);
    ctx.arc(9.4, 10.2, 1.4, Math.PI, 0);
    ctx.lineTo(10.8, 15.5);
    ctx.quadraticCurveTo(10.6, 20.5, 6.5, 21);
    ctx.lineTo(2.2, 21);
    ctx.quadraticCurveTo(-0.6, 20.6, -2.4, 17.6);
    ctx.lineTo(-5.4, 12.4);
    ctx.quadraticCurveTo(-6.2, 10.6, -4.6, 10.2);
    ctx.quadraticCurveTo(-3.2, 9.9, -1.6, 12);
    ctx.closePath();
    ink(ctx, '#fff', '#111', 1.4);
  },
  // hotspot = the middle
  iBeam(ctx) {
    ctx.beginPath();
    ctx.moveTo(-3.2, -8.5);
    ctx.quadraticCurveTo(0, -8.5, 0, -6.5);
    ctx.quadraticCurveTo(0, -8.5, 3.2, -8.5);
    ctx.moveTo(0, -6.5);
    ctx.lineTo(0, 6.5);
    ctx.moveTo(-3.2, 8.5);
    ctx.quadraticCurveTo(0, 8.5, 0, 6.5);
    ctx.quadraticCurveTo(0, 8.5, 3.2, 8.5);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  },
  crosshair(ctx) {
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(8, 0);
    ctx.moveTo(0, -8);
    ctx.lineTo(0, 8);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3.2;
    ctx.stroke();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.3;
    ctx.stroke();
  },
  openHand(ctx) {
    rrect(ctx, -6.5, -4, 13, 13, 5);
    ink(ctx, '#fff', '#111', 1.4);
    for (let i = 0; i < 4; i += 1) {
      rrect(ctx, -6 + i * 3.3, -10 + (i === 0 || i === 3 ? 2 : 0), 2.6, 9, 1.3);
      ink(ctx, '#fff', '#111', 1.2);
    }
  },
  closedHand(ctx) {
    rrect(ctx, -6.5, -4, 13, 12, 5);
    ink(ctx, '#fff', '#111', 1.4);
    for (let i = 0; i < 4; i += 1) {
      rrect(ctx, -6 + i * 3.3, -6, 2.6, 4.5, 1.3);
      ink(ctx, '#fff', '#111', 1.2);
    }
  },
  resizeLeftRight(ctx) {
    poly(ctx, [[-10, 0], [-5, -5], [-5, -2], [5, -2], [5, -5], [10, 0], [5, 5], [5, 2], [-5, 2], [-5, 5]]);
    ink(ctx, '#111', '#fff', 2);
  },
  resizeUpDown(ctx) {
    poly(ctx, [[0, -10], [5, -5], [2, -5], [2, 5], [5, 5], [0, 10], [-5, 5], [-2, 5], [-2, -5], [-5, -5]]);
    ink(ctx, '#111', '#fff', 2);
  },
  notAllowed(ctx) {
    SHAPES.arrow(ctx);
    ctx.beginPath();
    ctx.arc(12, 17, 4.5, 0, Math.PI * 2);
    ink(ctx, '#fff', '#c22', 1.6);
    ctx.beginPath();
    ctx.moveTo(9, 20);
    ctx.lineTo(15, 14);
    ctx.strokeStyle = '#c22';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  },
};

// Draws `shape` with its hotspot at (x, y). `size` = pixels per 24 units (a 1× macOS cursor is ~24 px tall).
export function draw(ctx, shape, x, y, size, angleDeg, alpha) {
  const fn = SHAPES[shape] || SHAPES.arrow;
  ctx.save();
  ctx.globalAlpha = alpha == null ? 1 : alpha;
  ctx.translate(x, y);
  if (angleDeg) ctx.rotate((angleDeg * Math.PI) / 180);
  const k = size / 24;
  ctx.scale(k, k);
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  fn(ctx);
  ctx.restore();
}

export function ring(ctx, x, y, size, progress) {
  const p = Math.max(0, Math.min(1, progress));
  ctx.save();
  ctx.globalAlpha = (1 - p) * 0.8;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.beginPath();
  ctx.arc(x, y, size * (0.25 + 0.75 * (1 - (1 - p) * (1 - p))), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export const shapes = Object.keys(SHAPES);

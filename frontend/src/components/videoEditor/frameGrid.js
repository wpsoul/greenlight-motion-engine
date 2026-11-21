// (polish3) Frame counts on the frame grid. A render at `fps` draws the frames whose times are i / fps; a span of time holds the frames
// whose times fall inside it. Counted as `Math.ceil(seconds * fps)`, a span whose float lands a few ulps over a whole number of frames
// counted one frame too many: render-onserver 2.9-3.0 s at 30 fps is (3.0 - 87 / 30) * 30 = 3.0000000000000027 frames and made 4
// (2.9, 2.933, 2.967 and 3.0), while 0.5-0.7 or 1-1.2, whose floats land just under, made 6. A millionth of a frame of slack keeps such
// an end on its grid line; a span really past a line (3.01 s) still takes the frame it reaches into.

/** Slack, in frames, for float error in `seconds * fps`. */
export const FRAME_SLACK = 1e-6;

/** The frames whose times i / fps lie before `seconds` (frames 0 .. n - 1): ceil(seconds * fps) on the grid. */
export function framesBefore(seconds, fps) {
  const n = Math.ceil(Number(seconds) * Number(fps) - FRAME_SLACK);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/** A whole film of `duration` seconds at `fps`: at least one frame. */
export function filmFrames(duration, fps) {
  return Math.max(1, framesBefore(duration, fps));
}

/** A range [start, end) of the timeline at `fps`: its first frame (the start snapped to the grid, as the exporter snaps it), the frame
 *  after its last, and how many it holds (at least one). */
export function rangeFrames(start, end, fps) {
  const from = Math.max(0, Math.round(Number(start) * Number(fps)) || 0);
  const to = Math.max(from + 1, framesBefore(end, fps));
  return { from, to, count: to - from };
}

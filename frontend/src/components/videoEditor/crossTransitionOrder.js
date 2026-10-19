// Extension-qualified: this module is covered by a node --test suite, which does
// not run Vite's resolver.

/*
 * Which clip MOVES to make room for a cross transition.
 *
 * Two clips have to overlap for a cross transition to have anything to cross, and
 * one of them has to give ground to create that overlap. Which one is the whole
 * of this setting — it is a TIMELINE question, not a rendering one:
 *
 *   'Next over previous' (the default, and how the editor has always worked)
 *      The incoming clip slides EARLIER by the transition's length, over the tail
 *      of the clip before it. The previous clip does not move and the timeline
 *      gets shorter by that length.
 *
 *   'Previous over next'
 *      The outgoing clip slides LATER by the transition's length, so its tail
 *      lands on the head of the clip after it. The next clip does not move, the
 *      timeline keeps its length, and a gap of that length opens up in front of
 *      the clip that moved.
 *
 * The transition itself renders identically either way — same frames, same
 * direction, same duration. Only where the two clips sit changes.
 */

// Compared against the stored display string rather than importing TransitionOrder
// so this stays a leaf the node suite (and speedUtils) can pull in freely.
const PREV_OVER_NEXT = 'Previous over next';

/** True when the clip BEFORE the cut is the one that gives ground. */
export function movesPreviousClip(order) {
  return order === PREV_OVER_NEXT;
}

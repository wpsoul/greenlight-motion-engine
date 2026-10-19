import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

// Playback/transport state for the video editor, shared between VideoEditor,
// Player and Timeline without prop-drilled useState.
//
// The split matters for performance:
// - `currentTime` is the COMMITTED time (seeks, pause-settle). Components that
//   need to re-render on it subscribe via the hook selector.
// - `playheadTime` is the LIVE playhead, written by the Player's RAF loop ONCE
//   PER DISPLAY FRAME during playback (not ~30fps — it is the display's cadence,
//   not the project's), and per mousemove while scrubbing. Nothing should
//   React-subscribe to it except leaf components, and those should select a
//   COARSENED value: the time readout selects a project-frame index, so it
//   re-renders at project fps rather than at display refresh.
//
//   Consumers that must move every frame read it imperatively instead of
//   subscribing: the Timeline drives its playhead, ruler and follow-scroll from
//   `getPlayheadTime()` inside its own playback RAF, and `useLivePlayhead` uses a
//   transient `useVideoEditorStore.subscribe(...)`. Either way playback renders
//   nothing.
export const useVideoEditorStore = create(
  subscribeWithSelector(
    immer((set) => ({
      isPlaying: false,
      currentTime: 0,
      playheadTime: 0,

      setIsPlaying: (next) =>
        set((s) => {
          s.isPlaying = typeof next === 'function' ? next(s.isPlaying) : next;
        }),
      setCurrentTime: (t) =>
        set((s) => {
          s.currentTime = t;
        }),
      setPlayheadTime: (t) =>
        set((s) => {
          s.playheadTime = t;
        }),
      // A user-visible seek: both the committed time and the visual playhead move.
      commitCurrentTime: (t) =>
        set((s) => {
          s.currentTime = t;
          s.playheadTime = t;
        }),
    })),
  ),
);

// Stable action references (safe in dependency arrays, never re-created).
const state = useVideoEditorStore.getState();
export const playbackActions = {
  setIsPlaying: state.setIsPlaying,
  setCurrentTime: state.setCurrentTime,
  setPlayheadTime: state.setPlayheadTime,
  commitCurrentTime: state.commitCurrentTime,
};

// Live playhead read for event handlers (split/paste/drop at playhead) — they
// want the value at call time, not a subscription.
export const getPlayheadTime = () => useVideoEditorStore.getState().playheadTime;

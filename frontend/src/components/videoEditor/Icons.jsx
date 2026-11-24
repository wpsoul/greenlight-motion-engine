export const PlayIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

export const PauseIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);

export const PlusIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const TrashIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export const DownloadIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export const FilmIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
    <line x1="7" y1="2" x2="7" y2="22" />
    <line x1="17" y1="2" x2="17" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="2" y1="7" x2="7" y2="7" />
    <line x1="2" y1="17" x2="7" y2="17" />
    <line x1="17" y1="17" x2="22" y2="17" />
    <line x1="17" y1="7" x2="22" y2="7" />
  </svg>
);

export const UploadIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

export const ScissorsIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <line x1="20" y1="4" x2="8.12" y2="15.88" />
    <line x1="14.47" y1="14.48" x2="20" y2="20" />
    <line x1="8.12" y1="8.12" x2="12" y2="12" />
  </svg>
);

// Split a clip at the playhead — two clip halves separated by the split line
// (not scissors: this divides, it doesn't cut anything away).
export const SplitIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2 2" />
    <path d="M9 5 H6 a1 1 0 0 0 -1 1 v12 a1 1 0 0 0 1 1 h3" />
    <path d="M15 5 h3 a1 1 0 0 1 1 1 v12 a1 1 0 0 1 -1 1 h-3" />
  </svg>
);

export const GripIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="5" r="1" />
    <circle cx="9" cy="19" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="5" r="1" />
    <circle cx="15" cy="19" r="1" />
  </svg>
);

export const TransitionIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <polyline points="16 6 12 2 8 6" />
    <line x1="12" y1="2" x2="12" y2="15" />
  </svg>
);

export const TransformIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 2v6h-6" />
    <path d="M3 12A9 9 0 0 1 18.36 5.64L21 8" />
    <path d="M3 22v-6h6" />
    <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
  </svg>
);

export const UndoIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </svg>
);

export const RedoIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 3.7" />
  </svg>
);

export const EyeIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const EyeOffIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

/* Speedometer for the SPEED CURVE header: open arc, hub, needle to 2 o'clock.
   Igor's reference (1.5px, evenodd arc) redrawn on the 2px lucide grid the other
   section icons use; the arc's ends sit at y=16 like the hub so it reads level. */
export const SpeedCurveIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 16v-1a9 9 0 0 1 18 0v1" />
    <circle cx="12" cy="16" r="2" />
    <path d="m13.4 14.6 3.1-3.1" />
  </svg>
);

export const GaugeIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
    <path d="M12 6v2" />
    <path d="M17.2 7.8l-1.4 1.4" />
    <path d="M18 12h-2" />
    <path d="M12 12l-3-3" />
  </svg>
);

export const SlidersIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <line x1="4" y1="21" x2="4" y2="14" />
    <line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" />
    <line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </svg>
);

export const LayersIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

export const TypeIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="4 7 4 4 20 4 20 7" />
    <line x1="9" y1="20" x2="15" y2="20" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </svg>
);

export const RestartIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

export const VolumeIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

export const VolumeMutedIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);

export const UnlinkIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M15 7h3a5 5 0 0 1 0 10h-3m-6 0H6a5 5 0 0 1 0-10h3" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);

export const LinkIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M15 7h3a5 5 0 0 1 0 10h-3m-6 0H6a5 5 0 0 1 0-10h3" />
    <line x1="8" y1="12" x2="16" y2="12" />
  </svg>
);

export const ApertureIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="10" />
    <line x1="14.31" y1="8" x2="20.05" y2="17.94" />
    <line x1="9.69" y1="8" x2="3.95" y2="17.94" />
    <line x1="7.38" y1="12" x2="16.62" y2="12" />
    <line x1="9.69" y1="16" x2="14.31" y2="8" />
    <line x1="14.31" y1="16" x2="9.69" y2="8" />
  </svg>
);

// Transport: jump to the previous / next timeline marker (flag + play triangle).
export const MarkerPrevIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="20 7 12 12 20 17 20 7" />
    <polygon points="4 4 9 4 9 12 6.5 10 4 12" stroke="none" />
  </svg>
);

export const MarkerNextIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="4 7 12 12 4 17 4 7" />
    <polygon points="15 4 20 4 20 12 17.5 10 15 12" stroke="none" />
  </svg>
);

export const SkipStartIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="19 5 9 12 19 19 19 5" />
    <line x1="5" y1="5" x2="5" y2="19" />
  </svg>
);

export const SkipEndIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="5 5 15 12 5 19 5 5" />
    <line x1="19" y1="5" x2="19" y2="19" />
  </svg>
);

// Project camera (player bar toggle + camera panel header).
export const CameraIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2 8.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
    <path d="M15 11l5.2-2.6a.6.6 0 0 1 .8.5v6.2a.6.6 0 0 1-.8.5L15 13z" />
  </svg>
);

// "This channel ignores the project camera" toggle on the timeline channel header.
export const CameraOffIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2 8.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
    <path d="M15 11l5.2-2.6a.6.6 0 0 1 .8.5v6.2a.6.6 0 0 1-.8.5L15 13z" />
    <line x1="3" y1="21" x2="21" y2="3" />
  </svg>
);

// A curve with its end anchors — the camera path.
export const PathIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 18c0-6 4-9 8-9s6 2 8 0" />
    <circle cx="4" cy="18" r="2" />
    <circle cx="20" cy="8" r="2" />
  </svg>
);

// Layer Mask — a frame with an ellipse punched through it, so the section icon
// reads as "a shape cutting the layer" rather than as another selection tool.
export const MaskIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <ellipse cx="12" cy="12" rx="5.2" ry="4.2" fill="currentColor" fillOpacity="0.22" />
  </svg>
);

// Motion Tracking — the AE track point: a box with a crosshair through it, the
// thing you actually drag onto the detail you want followed.
export const TargetIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1" />
    <line x1="12" y1="2.5" x2="12" y2="6.5" />
    <line x1="12" y1="17.5" x2="12" y2="21.5" />
    <line x1="2.5" y1="12" x2="6.5" y2="12" />
    <line x1="17.5" y1="12" x2="21.5" y2="12" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" />
  </svg>
);

export const MotionBlurIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="15" cy="12" r="5" />
    <line x1="2" y1="8" x2="7" y2="8" opacity="0.45" />
    <line x1="4" y1="12" x2="8" y2="12" opacity="0.7" />
    <line x1="2" y1="16" x2="7" y2="16" opacity="0.45" />
  </svg>
);

// Linked nodes stepping up a slope — the Keyframe Builder's graph editor toggle.
// Solid-filled rather than stroked like its neighbours: the shape is drawn from
// filled rings, so it needs fill="currentColor" and no stroke to take the button's
// hover colour.
export const GraphIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 485 485" fill="currentColor" {...props}>
    <path d="M430 102.509c-30.327 0-55 24.673-55 55a54.65 54.65 0 0 0 6.993 26.794l-61.444 61.445a54.65 54.65 0 0 0-26.794-6.993 54.65 54.65 0 0 0-26.794 6.993l-27.707-27.707a54.65 54.65 0 0 0 6.993-26.794c0-30.327-24.673-55-55-55s-55 24.673-55 55a54.65 54.65 0 0 0 6.993 26.794l-61.445 61.444A54.65 54.65 0 0 0 55 272.492c-30.327 0-55 24.673-55 55s24.673 55 55 55 55-24.673 55-55a54.64 54.64 0 0 0-6.993-26.793l61.445-61.444a54.65 54.65 0 0 0 26.794 6.993 54.65 54.65 0 0 0 26.794-6.993l27.707 27.707a54.65 54.65 0 0 0-6.993 26.794c0 30.327 24.673 55 55 55s55-24.673 55-55c0-9.724-2.547-18.86-6.993-26.794l61.444-61.444a54.65 54.65 0 0 0 26.794 6.993c30.327 0 55-24.673 55-55S460.327 102.509 430 102.509M55 352.491c-13.785 0-25-11.215-25-25s11.215-25 25-25 25 11.215 25 25-11.215 25-25 25m136.247-136.244c-13.785 0-25-11.215-25-25s11.215-25 25-25 25 11.215 25 25-11.215 25-25 25m102.508 102.507c-13.785 0-25-11.215-25-25s11.215-25 25-25 25 11.215 25 25-11.215 25-25 25M430 182.509c-13.785 0-25-11.215-25-25s11.215-25 25-25 25 11.215 25 25-11.215 25-25 25" />
  </svg>
);

// Grid Builder layers. Nine cells with the middle one filled — reads as "an
// arrangement of layers" rather than the generic four-square grid glyph the
// timeline and media views already use for something else.
export const GridLayerIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="3" width="5.5" height="5.5" rx="1.2" />
    <rect x="15.5" y="3" width="5.5" height="5.5" rx="1.2" />
    <rect x="3" y="15.5" width="5.5" height="5.5" rx="1.2" />
    <rect x="15.5" y="15.5" width="5.5" height="5.5" rx="1.2" />
    <rect x="9.25" y="9.25" width="5.5" height="5.5" rx="1.2" fill="currentColor" stroke="none" />
  </svg>
);

// Null layers: a ring with four ticks — a point in space, not a picture. Same
// glyph as the timeline's Add Layer ▸ Null entry.
export const NullLayerIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="5" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </svg>
);

// Motion-path CTA glyphs. A curve with keys on it (one key per anchor), a cube
// (World View), type riding a curve (Text on Path) and a curve becoming an
// outline (Create Shape From Path) — all drawn on the same 24-box at the same
// stroke weight as PathIcon, so the four buttons read as one family.
export const PathKeysIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 17c0-6 4-9 8-9s5.5 2 7.5 0.5" />
    <path d="M3 17 1.6 15.6 3 14.2 4.4 15.6Z" fill="currentColor" stroke="none" />
    <path d="M11 8 9.6 6.6 11 5.2 12.4 6.6Z" fill="currentColor" stroke="none" />
    <path d="M19.5 8.2 18.1 6.8 19.5 5.4 20.9 6.8Z" fill="currentColor" stroke="none" />
  </svg>
);

export const CubeIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 2.8 20.5 7.4v9.2L12 21.2 3.5 16.6V7.4Z" />
    <path d="M3.5 7.4 12 12l8.5-4.6" />
    <path d="M12 12v9.2" />
  </svg>
);

export const TextPathIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2.5 18.5c3.5-9 15.5-9 19 0" strokeDasharray="2.6 2.4" opacity="0.75" />
    <path d="M6.6 12.4h4.2M8.7 12.4V7.6" />
    <path d="M14 9.6h4.4M16.2 9.6v4.8" />
  </svg>
);

export const ShapeFromPathIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 16.5c0-7 5-10.5 9-8.5s5.5 4 7 2.5" />
    <rect x="2.2" y="14.7" width="3.6" height="3.6" rx="0.9" fill="currentColor" stroke="none" />
    <rect x="18.2" y="8.7" width="3.6" height="3.6" rx="0.9" fill="currentColor" stroke="none" />
  </svg>
);

/* Copy a curve from another path editor — the familiar two-sheets glyph, with a
   bezier on the front sheet so it reads as "copy a PATH", not "copy the layer". */
export const CopyPathIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M15.5 4.5H5.2a1.7 1.7 0 0 0-1.7 1.7v10.3" />
    <rect x="7.5" y="7.5" width="13" height="13" rx="2.2" />
    <path d="M10.2 17.4c0-3.6 2.2-6.6 4.4-5.4s2.6 2.2 3.4 1.3" />
  </svg>
);

// Smooth path — the same curve twice: a dense, kinked run of anchors above, one
// clean sweep with two anchors below. The point of the feature in one glyph.
export const SmoothPathIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 9.4 6 6.2l2.6 3.4L11.6 5l2.8 4 3-3.4L21 8.6" strokeOpacity="0.45" />
    <path d="M3 19c3.4 0 4.2-5.2 9-5.2s5.6 3.4 9 3.4" />
    <circle cx="3" cy="19" r="1.7" fill="currentColor" />
    <circle cx="21" cy="17.2" r="1.7" fill="currentColor" />
  </svg>
);

// Layer parenting (pick whip) — a chain link, "rig this layer to that one".
// Sits beside Presets in the KEYFRAMES header and turns green once a parent is
// picked. Filled shape, so no stroke: it takes the button colour via fill.
/* Layer parenting (keyframe builder header): a chain link at 45° with the bar
   through the middle — Igor's reference redrawn as 2px round strokes. */
export const ParentLinkIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    <path d="m9 15 6-6" />
  </svg>
);

/* TRANSITIONS header: two clips side by side with an arrow from one into the
   other — Igor's reference on the 2px stroke grid. */
export const TransitionPanelsIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M2 18V6a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3Z" />
    <path d="M16 3h2a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4h-2" />
    <path d="M10 12h8m0 0-3-3m3 3-3 3" />
  </svg>
);

/* KEYFRAMES header: one full diamond and two trailing chevron-diamonds —
   Igor's reference on the 2px stroke grid. */
export const KeyframesIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M13.848 13.317 9.505 18.28a2 2 0 0 1-3.01 0l-4.343-4.963a2 2 0 0 1 0-2.634L6.495 5.72a2 2 0 0 1 3.01 0l4.343 4.963a2 2 0 0 1 0 2.634" />
    <path d="m13 19 4.884-5.698a2 2 0 0 0 0-2.604L13 5" />
    <path d="m17 19 4.884-5.698a2 2 0 0 0 0-2.604L17 5" />
  </svg>
);

export const ChainLinkIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M5.9 24c-1.6 0-3.1-.6-4.2-1.7S0 19.7 0 18.1s.6-3.1 1.7-4.2l3.8-3.8 2 2 2.8-2.8 1.4 1.4-2.8 2.8 1.6 1.6 2.8-2.8 1.4 1.4-2.8 2.8 2 2-3.7 3.8C9 23.3 7.5 24 5.9 24m-.4-11.1-2.3 2.3C2.4 16 2 17 2 18s.4 2 1.2 2.8c1.5 1.5 4.1 1.5 5.6 0l2.3-2.4zm13 1-8.4-8.4 3.7-3.8C14.9.6 16.5 0 18 0s3 .6 4.2 1.7S24 4.3 24 5.9s-.6 3.1-1.7 4.2zM13 5.5l5.5 5.5 2.3-2.3C21.6 7.9 22 7 22 5.9c0-1-.4-2-1.2-2.8-1.5-1.5-4-1.5-5.6 0z" />
  </svg>
);

// Capture — stamp the pose under the playhead onto the tracks: a target reticle,
// "record what is sighted right now", the gesture-free twin of the gizmo's
// auto-key. Sits beside Presets in the KEYFRAMES header, and only while this
// position has something left to capture. Distinct from TargetIcon above, which
// is the motion-TRACK point (a box you drag onto a detail), not a capture.
// Drawn tight — at 13px the ticks have to clear the ring or the two smear.
export const KeyCaptureIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    <path d="M12 1.6v2.4M12 20v2.4M1.6 12H4M20 12h2.4" />
  </svg>
);

/* ── Section header icons ──────────────────────────────────────────────────
   One glyph per right-panel section, all on the same 24-box / stroke-2 grid.
   Before these, SlidersIcon fronted ~18 sections, every particle section
   shared one dots glyph and every Scene Rig section shared RigIcon. */

// KEYFRAMES — diamonds on a track. The shared header icon for the Keyframe
// Builder in every panel (layer, camera, rig): same feature, same glyph.
export const KeyDiamondsIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <line x1="2.5" y1="12" x2="21.5" y2="12" opacity="0.45" />
    <path d="M8 8.3 11.7 12 8 15.7 4.3 12Z" fill="currentColor" stroke="none" />
    <path d="M17 9.4 19.6 12 17 14.6 14.4 12Z" fill="currentColor" stroke="none" />
  </svg>
);

// Zoom fit — corner brackets with the arrows pulling back in: "restore the
// 100% view" on a stretched keyframe builder.
export const ZoomFitIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 8V3h5" /><path d="M21 8V3h-5" /><path d="M3 16v5h5" /><path d="M21 16v5h-5" />
    <path d="M9 12H4" /><path d="M6.5 9.5 4 12l2.5 2.5" /><path d="M15 12h5" /><path d="m17.5 9.5 2.5 2.5-2.5 2.5" />
  </svg>
);

// LUT — a lookup-cube slice.
export const LutIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <line x1="9.2" y1="3.5" x2="9.2" y2="20.5" />
    <line x1="14.8" y1="3.5" x2="14.8" y2="20.5" />
    <line x1="3.5" y1="9.2" x2="20.5" y2="9.2" />
    <line x1="3.5" y1="14.8" x2="20.5" y2="14.8" />
    <rect x="9.2" y="9.2" width="5.6" height="5.6" fill="currentColor" stroke="none" opacity="0.4" />
  </svg>
);

// LAYER EFFECTS — magic wand.
export const WandIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 20 13.5 10.5" />
    <path d="m15.8 4 1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" fill="currentColor" stroke="none" />
    <path d="m20 12.6.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z" fill="currentColor" stroke="none" />
    <path d="m7.5 3.4.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill="currentColor" stroke="none" />
  </svg>
);

// HTML — a page as a layer (htmlClips.js): angle brackets around a slash.
export const CodeIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
    <path d="m13.5 4.5-3 15" />
  </svg>
);

// SEQUENCE — ordered frames with a play direction.
export const SequenceIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="2.5" y="6" width="5.4" height="8.4" rx="1" />
    <rect x="9.3" y="6" width="5.4" height="8.4" rx="1" />
    <rect x="16.1" y="6" width="5.4" height="8.4" rx="1" />
    <path d="M4.5 19h13.5" />
    <path d="m15.8 16.8 2.2 2.2-2.2 2.2" />
  </svg>
);

// CAMERA TRACKING — the solved point cloud (TargetIcon stays with motion
// tracking: that one is the track point you drag onto footage).
export const PointCloudIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M5.5 7 12 4l6.5 3M5.5 7v9L12 20m-6.5-4 6.5-3m6.5-6v9L12 20m0-11v11" opacity="0.45" strokeDasharray="1.8 1.8" />
    <circle cx="5.5" cy="7" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="12" cy="4" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="7" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="5.5" cy="16" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="12" cy="20" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="16" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="12" cy="9" r="1.7" fill="currentColor" stroke="none" />
  </svg>
);

// DEPTH EFFECTS — a plane receding to a horizon: near is wide, far is narrow.
// Deliberately unframed. WandIcon stays with LAYER EFFECTS (the two sections sit
// next to each other and shared it), and every framed icon around it — BORDER,
// SHADOWS, LAYER MASK — is a square inside a square, so this cannot be one.
export const DepthIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3.5 6.5h17" />
    <path d="M9.6 6.5 3.5 20.5M14.4 6.5l6.1 14" />
    <path d="M7.9 11.4h8.2" opacity="0.6" />
    <path d="M6 15.7h12" opacity="0.6" />
  </svg>
);

// OVERLAY EFFECTS — a layer stacked over the frame, with a sparkle.
export const OverlayFxIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="7" width="13.5" height="13.5" rx="2" />
    <path d="M8 4h10a3 3 0 0 1 3 3v10" opacity="0.55" />
    <path d="m9.7 10.4 1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" fill="currentColor" stroke="none" />
  </svg>
);

// PROJECT · BACKGROUND — landscape in a frame.
export const LandscapeIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <circle cx="9" cy="9.5" r="1.6" />
    <path d="m3.5 17 4.5-4.5 3.5 3.5 4-5 5 6" />
  </svg>
);

// PROJECT · DESIGN TOKENS — colour palette.
export const PaletteIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.4-2-.8-1.4.2-3 1.9-3H17a4.5 4.5 0 0 0 4-4.6C20.7 6.6 16.8 3 12 3z" />
    <circle cx="7.8" cy="10.2" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16.2" cy="10.2" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

// PROJECT · QUALITY — a gem.
export const GemIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M7 4h10l4 5.2L12 20.5 3 9.2z" />
    <path d="M3 9.2h18M7 4l5 5.2L17 4M12 20.5 8.7 9.2m3.3 11.3 3.3-11.3" opacity="0.5" />
  </svg>
);

// MOTION TEMPLATE — template layout with a play tile.
export const TemplateIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9.5h18M9.5 9.5V20" />
    <path d="m13.6 12.9 4 2.4-4 2.4z" fill="currentColor" stroke="none" />
  </svg>
);

// SHAPE — square + circle primitives.
export const ShapesIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3.5" y="3.5" width="11" height="11" rx="1.5" />
    <circle cx="15.3" cy="15.3" r="5.6" />
  </svg>
);

// BACKGROUND (card fill) — paint roller, distinct from the project landscape.
export const PaintRollerIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4" width="13" height="5.5" rx="1.5" />
    <path d="M16 6.8h2.5a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H12v2.6" />
    <rect x="10.6" y="15.4" width="2.8" height="5.6" rx="1" />
  </svg>
);

// FILTERS — contrast half-circle.
export const ContrastIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" opacity="0.45" />
  </svg>
);

// BORDER — solid frame around a dashed content box.
export const BorderIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1" strokeDasharray="2.3 1.9" opacity="0.6" />
  </svg>
);

// SHADOWS (layer) — card with a drop shadow behind it.
export const CardShadowIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="4" y="4" width="12.5" height="12.5" rx="2" />
    <path d="M20 9.8v7.7a2.5 2.5 0 0 1-2.5 2.5H9.8" opacity="0.5" />
  </svg>
);

// BACKDROP BLUR — a glass pane over a soft (blurred) disc behind it.
export const BackdropBlurIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="14.5" cy="9.5" r="5.5" opacity="0.45" strokeDasharray="2.2 2.4" />
    <rect x="3.5" y="8.5" width="12" height="12" rx="2.2" />
  </svg>
);

// GLASS — a lens pane: a rounded plate with a bent highlight inside its edge.
export const GlassIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="4.5" />
    <path d="M7.5 15.5c0-4 2.2-7 6.5-7.5" opacity="0.6" />
  </svg>
);

// TEXT COLORS — the font-colour "A" over a swatch bar.
export const TextColorIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="m5.5 16.5 5-12.5h3l5 12.5M7.7 12.5h8.6" />
    <rect x="4.5" y="19.5" width="15" height="2.6" rx="1.3" fill="currentColor" stroke="none" opacity="0.85" />
  </svg>
);

// TEXT SHADOW — a "T" with its offset ghost.
export const TextShadowIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M8.5 7.5V5.5h11v2M14 5.5v13M12 18.5h4" />
    <path d="M4.5 10.5V9h7v1.5M8 9v9.5M6.5 18.5h3" opacity="0.4" />
  </svg>
);

// TEXT RANDOMIZER — shuffle arrows.
export const ShuffleIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 7h4.2L17 17h4" />
    <path d="M3 17h4.2l2.6-2.7M14.2 9.7 17 7h4" />
    <path d="m18.6 4.4 2.6 2.6-2.6 2.6M18.6 14.4l2.6 2.6-2.6 2.6" />
  </svg>
);

// PRESETS — a grid of ready-made looks, one of them picked (the filled tile).
export const PresetsIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" {...props}>
    <rect x="2" y="2" width="9.5" height="9.5" rx="2.4" fill="currentColor" stroke="none" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
  </svg>
);

// COUNTER — two odometer windows, each digit rolling up.
export const CounterIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M12 5v14" />
    <path d="m5.5 13.5 2-2 2 2M14.5 13.5l2-2 2 2" />
  </svg>
);

// WORD CYCLE — a word leaving upward as the next one arrives.
export const WordCycleIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 7h11" opacity="0.45" />
    <path d="M4 12h16" />
    <path d="M4 17h8" opacity="0.45" />
    <path d="m18 4 2 2.5L18 9" />
  </svg>
);

// SCRAMBLE — glyphs resolving: a slash, a hash, then a settled bar.
export const ScrambleIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 17 7 7" />
    <path d="M10 9h5M10 14h5M11.5 6.5l-1 10M14.5 6.5l-1 10" />
    <path d="M18 7v10" />
  </svg>
);

// TEXT VARIABLES — a value between braces.
export const VariableIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M8 4c-2 0-2.5 1-2.5 3v2c0 1.5-.8 2.5-2.5 3 1.7.5 2.5 1.5 2.5 3v2c0 2 .5 3 2.5 3" />
    <path d="M16 4c2 0 2.5 1 2.5 3v2c0 1.5.8 2.5 2.5 3-1.7.5-2.5 1.5-2.5 3v2c0 2-.5 3-2.5 3" />
    <path d="m9.5 9 5 6M14.5 9l-5 6" />
  </svg>
);

// TEXT ANIMATION — a "T" sliding in with speed lines.
export const TextAnimIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M9.5 7V5h11v2M15 5v14M13 19h4" />
    <path d="M3 8h3.5M2 12h4.5M3 16h3.5" opacity="0.5" />
  </svg>
);

/* ── Particle solver sections ── */

// PRESET — star.
export const StarIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="m12 3.2 2.5 5.1 5.7.9-4.1 4 1 5.6L12 16.2l-5.1 2.6 1-5.6-4.1-4 5.7-.9z" />
  </svg>
);

// PARTICLE OBJECT — the shapes a particle can be.
export const ParticleObjectsIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="7" cy="7.3" r="3.4" />
    <rect x="13.9" y="3.9" width="6.6" height="6.6" rx="1.2" />
    <path d="m12 13.6 4 6.9H8z" />
  </svg>
);

// SOLVER BOX — dashed simulation bounds with particles inside.
export const SolverBoxIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 2.4" />
    <circle cx="9.5" cy="10" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="14.8" cy="8.3" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.3" cy="14.6" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

// EMITTER — nozzle spraying particles.
export const EmitterIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="9.3" width="6.5" height="5.4" rx="1.2" />
    <path d="M9.5 12h2.3" />
    <circle cx="15" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16.3" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="16" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="19.8" cy="5.8" r="1" fill="currentColor" stroke="none" />
    <circle cx="21" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="19.8" cy="18.2" r="1" fill="currentColor" stroke="none" />
  </svg>
);

// PARTICLE ACTIVATION — bolt.
export const BoltIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M13.2 2.5 5.5 13.5h5L10 21.5l7.7-11h-5z" />
  </svg>
);

// GROWTH FIELD — sprout.
export const SproutIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 21.5v-8" />
    <path d="M12 13.5c0-3.8 2.6-6.3 6.8-6.3 0 3.8-2.6 6.3-6.8 6.3z" />
    <path d="M12 16c0-2.7-1.9-4.6-5.2-4.6 0 2.7 1.9 4.6 5.2 4.6z" />
  </svg>
);

// FORCES — wind.
export const WindIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 8h9.7a2.3 2.3 0 1 0-2.3-2.3" />
    <path d="M3 12.5h13.8a2.6 2.6 0 1 1-2.6 2.6" />
    <path d="M3 17h6.5" />
  </svg>
);

// TURBULENCE — choppy waves.
export const WavesIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 8.2c3-3.4 5 3.4 9 0s6 2.3 9-1.1" />
    <path d="M3 15.9c3-3.4 5 3.4 9 0s6 2.3 9-1.1" />
  </svg>
);

// VORTEX — the spiral (the retired pick-whip coil, minus its arrow).
export const VortexIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12.4 12.1a1.9 1.9 0 1 1-2.5-1.8 3.9 3.9 0 1 1 4.5 6 6 6 0 1 1-7.9-8.6 8 8 0 0 1 13.6 3.9" />
  </svg>
);

// PARTICLE COLOUR — droplet.
export const DropletIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 3.5s6.3 6.6 6.3 10.8a6.3 6.3 0 0 1-12.6 0C5.7 10.1 12 3.5 12 3.5z" />
    <path d="M9.2 14.5a2.9 2.9 0 0 0 2.5 2.7" opacity="0.55" />
  </svg>
);

// EFFECTORS — a silhouette with its own distance field rippling out from it.
// Deliberately NOT a plain target/radar: the whole point of a particle effector
// is that the field takes the SHAPE of the source, so the rings follow the blob
// rather than sitting concentric around a point.
export const EffectorIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M9.6 8.3c1.9-1.6 4.3-1 5 .9.7 2-.7 3.6-2.7 4.4-2 .8-3.4 2.2-2.9 3.9" opacity="0" />
    <path d="M12 8.2c1.9 0 3.1 1.1 3.1 2.6 0 1.6-1.2 2.4-3.1 2.4s-3.1-.8-3.1-2.4c0-1.5 1.2-2.6 3.1-2.6z" fill="currentColor" stroke="none" />
    <path d="M12 6.1c3.2 0 5.2 2 5.2 4.7 0 2.8-2 4.4-5.2 4.4s-5.2-1.6-5.2-4.4c0-2.7 2-4.7 5.2-4.7z" opacity="0.62" />
    <path d="M12 3.6c4.8 0 7.7 3 7.7 7.2 0 4.2-2.9 6.9-7.7 6.9s-7.7-2.7-7.7-6.9c0-4.2 2.9-7.2 7.7-7.2z" opacity="0.3" />
    <circle cx="6.2" cy="19.6" r="1" fill="currentColor" stroke="none" opacity="0.75" />
    <circle cx="12" cy="21" r="1" fill="currentColor" stroke="none" opacity="0.75" />
    <circle cx="17.8" cy="19.6" r="1" fill="currentColor" stroke="none" opacity="0.75" />
  </svg>
);

/* ── Camera panel sections ── */

// MOVEMENT — pan arrows.
export const PanArrowsIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 3v18M3 12h18" />
    <path d="m9.6 5.4 2.4-2.4 2.4 2.4M9.6 18.6l2.4 2.4 2.4-2.4M5.4 9.6 3 12l2.4 2.4M18.6 9.6 21 12l-2.4 2.4" />
  </svg>
);

// CAMERA RIG — tripod.
export const TripodIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="6" r="2.9" />
    <path d="M12 8.9V13M12 13l-5.6 8M12 13l5.6 8M8.5 18.2h7" />
  </svg>
);

// CAMERA PATH — path with a direction arrowhead (the layer MOTION PATH keeps
// PathIcon's anchor dots).
export const CameraPathIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3.5 18.5c1-7 4.8-10 8.6-8.7 3 1 4.6 3.2 7.4 3" />
    <path d="m16.6 9.6 3.4 3-4.2 1.4" />
    <circle cx="3.5" cy="18.5" r="1.8" fill="currentColor" stroke="none" />
  </svg>
);

// SAVE THIS MOVE — bookmark-plus.
export const BookmarkPlusIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M6.5 3.5h11V21L12 16.9 6.5 21z" />
    <path d="M12 7.2v4.6M9.7 9.5h4.6" />
  </svg>
);

/* ── Scene Rig sections (RIG itself keeps RigPanel's sun glyph) ── */

// CYCLORAMA — the cyc wall sweeping into the floor.
export const CycloramaIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4.5 3.5v9.5a7.5 7.5 0 0 0 7.5 7.5h8.5" />
    <path d="M9 3.5v8.3a5.2 5.2 0 0 0 5.2 5.2h6.3" opacity="0.5" />
  </svg>
);

// SHADOWS (rig) — object casting a ground shadow.
export const GroundShadowIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="8.5" y="3.5" width="7" height="10.5" rx="1.5" />
    <ellipse cx="12" cy="19" rx="7.5" ry="2.3" opacity="0.55" />
  </svg>
);

// ENVIRONMENT — globe.
export const GlobeIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.9 2.8 2.9 14.2 0 17-2.9-2.8-2.9-14.2 0-17z" />
  </svg>
);

/* ── Voice & captions sections ── */

// VOICE CHANGE — microphone.
export const MicIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="8.8" y="2.5" width="6.4" height="11" rx="3.2" />
    <path d="M5.5 10.5a6.5 6.5 0 0 0 13 0M12 17v4.5" />
  </svg>
);

// AVATAR VIDEO — person in frame.
export const AvatarIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="12" cy="10.3" r="2.7" />
    <path d="M6.8 20c.8-3.1 2.8-4.7 5.2-4.7s4.4 1.6 5.2 4.7" />
  </svg>
);

// TELEPROMPTER — a screen of lines on a stand.
export const TeleprompterIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="3.5" width="18" height="13" rx="2" />
    <path d="M7 8h10M7 11.8h6.5" />
    <path d="M12 16.5v4M8.5 20.5h7" />
  </svg>
);

// TRANSCRIPT — document with lines.
export const TranscriptIcon = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M6.5 2.8h7.2l4.8 4.8v13.6H6.5z" />
    <path d="M13.7 2.8v4.8h4.8M9.7 12.2h5M9.7 15.8h5" />
  </svg>
);

/* "Animate this property" affordance. A stopwatch, not a diamond: the diamond is
   what a keyframe looks like ON the timeline, and reusing it beside a field read
   as "this is a key" rather than "put this on a clock". Tracked state is carried
   by colour + a heavier stroke.

   Lives here rather than in EditorPanel because panels EditorPanel itself imports
   (the particle inspector) need it, and importing it back out of EditorPanel would
   close a cycle. */
export function KfClockIcon({ filled }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={filled ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 9.6v4.1l2.4 1.6" />
      <path d="M9.2 2.4h5.6" />
      <path d="M18.6 4.6l1.8 1.8" />
    </svg>
  );
}

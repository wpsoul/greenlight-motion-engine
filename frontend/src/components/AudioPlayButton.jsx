import { useRef, useState } from "react";

// Small round play/pause button overlaid on an audio tile (bottom-right).
// Plays the clip inline without triggering the tile's own click (select/open).
export default function AudioPlayButton({ src, className = "" }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  if (!src) return null;

  const toggle = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      a.pause();
    }
  };

  return (
    <button
      type="button"
      className={`generation-audio-play-btn ${className}`}
      onClick={toggle}
      onMouseDown={(e) => e.stopPropagation()}
      title={playing ? "Pause" : "Play"}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      {playing ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="7,4 20,12 7,20" />
        </svg>
      )}
    </button>
  );
}

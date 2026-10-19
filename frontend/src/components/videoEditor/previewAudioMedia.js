// iOS grants audible playback per element. Keep a channel's element across
// source changes so a later clip retains the Play gesture's authorization.
export function ensurePreviewAudio(elements, key, url, preload = 'auto') {
  let audio = elements.get(key);
  if (!audio) {
    audio = document.createElement('audio');
    audio.crossOrigin = 'anonymous';
    elements.set(key, audio);
  }
  audio.preload = preload;
  if (audio._clipUrl !== url) {
    audio.pause();
    delete audio.__glDriftSync;
    audio._clipUrl = url;
    audio.src = url;
    audio.load();
  }
  return audio;
}

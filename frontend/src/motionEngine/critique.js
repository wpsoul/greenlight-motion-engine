// A 3D Scene's critique on the engine's own page (the chat connector, the CLI, an agent driving the page): the frame just drawn, what
// its shot shows object by object and where its lights stand (world3d/critique.js through the Scene layer), the picture's numbers and
// hints in plain words (world3d/schema/critiqueHints.js: the same rules as GreenLight Dash's server). Nothing runs unless asked.
import { worldPoseAt, worldSceneReport } from '../components/videoEditor/world3dLayer';
import { layers2dReport, worldPathReport } from '../components/videoEditor/worldLayerCritique';
import { critiqueHints, coverageRows, imageStats, objectBrightness } from '../world3d/schema/critiqueHints';

/** The Scene's render mode in a project: 'final' when a Scene layer asks for it. */
export function sceneMode(project) {
  for (const ch of project?.channels || []) for (const it of ch.items || []) if (it?.rig?.render?.mode === 'final') return 'final';
  return 'draft';
}

const pixels = async (dataUrl) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return { data: g.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
};

/** The critique of the frame `dataUrl` the page has just drawn at `time`. `objects`: the ids the shot is about (optional). */
export async function critiqueFrame(dataUrl, { project, objects = null, time = 0 } = {}) {
  // The capture puts the playhead back and draws that frame again: measure the world as it stood in this still, then put it back.
  const putBack = worldPoseAt(time);
  try { return await measure(dataUrl, { project, objects, time }); } finally { putBack(); }
}

async function measure(dataUrl, { project, objects, time }) {
  const wanted = Array.isArray(objects) && objects.length ? objects.map(String) : null;
  const scene = worldSceneReport({ critique: true, objects: wanted });
  const mode = sceneMode(project);
  const { data, width, height } = await pixels(dataUrl);
  const stats = imageStats(data, width, height);
  const crit = scene?.critique || {};
  // The 2D layers over the world (hidden behind its objects, contrast, frame, title-safe, texts on texts) and the camera's move over
  // the whole clip: no render, the frame above and the world as it stands (components/videoEditor/worldLayerCritique.js).
  if (scene?.critique && !crit.error) {
    try {
      crit.layers2d = layers2dReport({ channels: project?.channels, clips: project?.clips, time, width: project?.videoSize?.w || width,
        height: project?.videoSize?.h || height, fps: project?.projectFps || 30, rgba: data, frameWidth: width, frameHeight: height });
    } catch (e) { crit.layers2dError = String(e?.message || e); }
    try { const path = worldPathReport(); if (path) crit.path = path; } catch (e) { crit.pathError = String(e?.message || e); }
  }
  return {
    mode,
    built: scene?.built ?? null,
    ...(scene?.error ? { error: scene.error } : null),
    image: stats,
    objects: coverageRows(scene, wanted),
    background: crit.coverage?.background ?? null,
    notMeasured: crit.coverage?.notMeasured?.length ? crit.coverage.notMeasured : undefined,
    lights: crit.lights || [],
    subject: crit.subject || null,
    objectBrightness: objectBrightness(data, width, height, crit.coverage),
    shotMs: crit.coverage?.ms ?? null,
    ...(crit.layers2d ? { layers2d: crit.layers2d } : null),
    ...(crit.path ? { path: crit.path } : null),
    hints: critiqueHints({ mode, stats, scene, wanted }),
  };
}

/*
 * Built-in scripts (PLANS/ESSENTIAL_TEMPLATES.md §14): the MotionFast templates whose motion comes from a computation,
 * remade as scripts on sequences (§13) that ship with the app. Each one is registered as an Essential kind (kind =
 * its MotionFast template id; builtin/kind.js), so it has the Essential panel, the stale rule, hand edits, photo
 * slots, "LAYERS", "Convert to layers" and the agent stub. Every built-in script is FREE (owner, 2026-11-23), whatever
 * its MotionFast original costs.
 *
 * This file is the eager part: the ids, names and categories (what the gallery's LAYERS button, the PRO gates and the
 * capabilities list need without running anything). A script's own module loads on first use (dynamic import, one
 * chunk each): when it is inserted, converted, opened in a project, rebuilt or listed for agents.
 *
 * A module (`./<motion-template-id>.js`) is `export default { id, name, category, v?, fields, build, fromMotionParams? }`
 * in the §13 script format, and imports nothing: the same text runs as a `kind: "script"` source behind the wall, so
 * it is a true example of what an agent can write.
 *
 * Pure, explicit .js imports: the editor, the render page, the PRO gates and node tests load it.
 */

export const BUILTIN_SCRIPTS = Object.freeze([
  Object.freeze({ id: 'orbit', name: 'Carousel', category: 'Carousels' }),
  Object.freeze({ id: 'image-trail', name: 'Image Trail', category: 'Carousels' }),
  Object.freeze({ id: 'tumble', name: 'Tumble', category: 'Carousels' }),
  Object.freeze({ id: 'toss', name: 'Toss', category: 'Carousels' }),
  Object.freeze({ id: 'grid-3d-reveal', name: '3D Grid', category: 'Carousels' }),
  Object.freeze({ id: 'media-orbit-burst', name: 'Media Orbit', category: 'Carousels' }),
  Object.freeze({ id: 'card-fan-cycle', name: 'Card Fan', category: 'Carousels' }),
  Object.freeze({ id: 'card-stack-drop', name: 'Stacking Cards', category: 'Carousels' }),
  Object.freeze({ id: 'card-stack-unstack', name: 'Unstacking Cards', category: 'Carousels' }),
  Object.freeze({ id: 'scatter-cards-flow', name: 'Scatter Cards', category: 'Carousels' }),
  Object.freeze({ id: 'tiled-gallery', name: 'Tiled Gallery', category: 'Carousels' }),
  Object.freeze({ id: 'card-corridor', name: 'Card Corridor', category: 'Carousels' }),
  Object.freeze({ id: 'glow-edge-pill', name: 'Glow Edge Pill', category: 'UI Animation' }),
  Object.freeze({ id: 'sliced-rolling-text', name: 'Sliced Rolling Text', category: '3D Text' }),
  Object.freeze({ id: 'split-clones', name: 'Split Clones', category: 'Typography' }),
  Object.freeze({ id: 'cascading-ticker', name: 'Cascading Ticker', category: 'Typography' }),
  Object.freeze({ id: 'kinetic-perspective-type', name: 'Kinetic Perspective Type', category: 'Typography' }),
]);

// motion template id → its module (each one a separate chunk)
const LOADERS = {
  orbit: () => import('./orbit.js'),
  'image-trail': () => import('./image-trail.js'),
  tumble: () => import('./tumble.js'),
  toss: () => import('./toss.js'),
  'grid-3d-reveal': () => import('./grid-3d-reveal.js'),
  'media-orbit-burst': () => import('./media-orbit-burst.js'),
  'card-fan-cycle': () => import('./card-fan-cycle.js'),
  'card-stack-drop': () => import('./card-stack-drop.js'),
  'card-stack-unstack': () => import('./card-stack-unstack.js'),
  'scatter-cards-flow': () => import('./scatter-cards-flow.js'),
  'tiled-gallery': () => import('./tiled-gallery.js'),
  'card-corridor': () => import('./card-corridor.js'),
  'glow-edge-pill': () => import('./glow-edge-pill.js'),
  'sliced-rolling-text': () => import('./sliced-rolling-text.js'),
  'split-clones': () => import('./split-clones.js'),
  'cascading-ticker': () => import('./cascading-ticker.js'),
  'kinetic-perspective-type': () => import('./kinetic-perspective-type.js'),
};

const BY_ID = new Map(BUILTIN_SCRIPTS.map((e) => [e.id, e]));

export const builtinScriptIds = () => BUILTIN_SCRIPTS.map((e) => e.id);
export const isBuiltinScriptId = (id) => typeof id === 'string' && BY_ID.has(id);
export const builtinScriptEntry = (id) => (isBuiltinScriptId(id) ? BY_ID.get(id) : null);

/** The script module's default export, loaded on first use. */
export async function loadBuiltinScriptModule(id) {
  if (!isBuiltinScriptId(id) || typeof LOADERS[id] !== 'function') throw new Error(`No built-in script "${id}".`);
  const mod = await LOADERS[id]();
  return mod.default || mod;
}

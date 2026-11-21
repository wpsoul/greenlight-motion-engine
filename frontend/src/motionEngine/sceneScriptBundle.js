// What the npm package exports as `greenlight-motion/script` (dist/greenlight-motion-script.mjs) and what the connector
// bundles (cloud/mcp-worker/src/vendor/sceneScript.mjs): the scene script converter, its guide, the media header
// readers and the template check. Built by motion-engine/scripts/build-script.mjs; never part of the engine page.
export * from './sceneScript.js';
export * from './sceneScriptGuide.js';
export * from './mediaProbe.js';
export { checkTemplate } from './template.js';
// a 3D Scene's field help and strict check (the Scene schema, shared with GreenLight Dash): get_motion_reference "world3d" answers with them
export { fieldHelp as world3dHelp, validateRig as validateWorld } from '../world3d/schema/validate.js';
// (motion3d) the 3D plugin's contract (its package, the world API, the CDN, version ranges) and what a Final render costs against a
// host's cap — the connector and the CLI check a project with the same code the page renders it with
export { WORLD3D_PACKAGE, WORLD3D_API, WORLD3D_CDN, WORLD3D_HDR, cdnRange, satisfies, hasWorld } from './world3dContract.js';
export { CHAT_FINAL_CAP, finalCost, checkFinalCap } from './finalCap.js';
// (chatswitch) a film's own Draft | Final and the film in another mode: the connector prices render_video in the mode the user switched
// the page to (the page's Draft | Final switch, reported with its contact sheet)
export { filmWorldMode, withWorldMode } from './worldMode.js';

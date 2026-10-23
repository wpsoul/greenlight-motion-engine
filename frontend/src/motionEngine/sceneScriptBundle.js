// What the npm package exports as `greenlight-motion/script` (dist/greenlight-motion-script.mjs) and what the connector
// bundles (cloud/mcp-worker/src/vendor/sceneScript.mjs): the scene script converter, its guide, the media header
// readers and the template check. Built by motion-engine/scripts/build-script.mjs; never part of the engine page.
export * from './sceneScript.js';
export * from './sceneScriptGuide.js';
export * from './mediaProbe.js';
export { checkTemplate } from './template.js';

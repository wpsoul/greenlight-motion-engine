/*
 * Phone mode: what the engine keeps in memory on a phone (html/INTERFACE/motion-mobile-lab: a big film passed what a
 * phone gives a tab and the page was closed). One flag, turned on only by the engine's own page on a touch device
 * (motionEngine/engineEntry.jsx). The editor never turns it on, so every branch that reads it is a no-op in the app.
 * The work itself is in ./phoneMedia.js. Kept a leaf: anything may import it.
 */
let on = false;
export const phoneMode = () => on;
export function setPhoneMode(value) { on = !!value; }
// previewing on a phone (or rendering its cache): not a real render, which draws everything at its own size
export const phonePreview = (engine) => on && !engine.phonePictureEdge;

export const PHONE_LONG_EDGE = 960;          // the preview's render size (a film draws at the view's size, not 1920)
export const PHONE_PICTURE_EDGE = 1024;      // a picture's longest edge in memory, while previewing
export const PHONE_PICTURE_BUDGET = 160 * 1024 * 1024;   // the pictures' GPU bytes; past it the longest unused go
export const PHONE_LOOK_AHEAD_S = 3;         // pictures decoded ahead of the playhead
export const PHONE_WARM_UP_S = 4;            // the idle warm-up's reach past the playhead
export const PHONE_SEQUENCE_KEEP_MS = 1500;  // a scene the playhead left keeps its videos and buffers this long
export const PHONE_PLATE_REACH_S = 2.5;      // a layer's plate is kept this close to the playhead
export const PHONE_PLATE_BUCKETS = Object.freeze([0.5, 0.75]);   // text and shape plates, of the composition's size: a grid of
                                                                 // 39 words at 1× was 300 MB, a scene's worst moment

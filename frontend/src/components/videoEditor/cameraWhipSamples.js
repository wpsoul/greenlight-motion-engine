// How many shutter samples Camera Whip integrates per plate.
//
// It lives in its own leaf module because BOTH backends must use the same
// number — the GLSL in builtinTransitionPackages.js interpolates it into a
// `const int`, the TSL twin in transitionPackageNodes.js unrolls that many
// nodes — and transitionPackageNodes.js must not import the packages module
// (that would close the cycle: packages → materialFactory → nodes).
//
// 32 with the per-pixel shutter dither is the point where a full-frame whip at
// 255 degrees stops reading as a comb of ghosts; 3D Carousel needs only 16
// because its panels travel a fraction as far across the frame.
//
// This is the CAP. The count a frame actually runs is sized per plate from the
// smear's extent in pixels (cameraWhipSampleCount) and handed to the shader as
// a uniform loop bound, so a settled camera costs one sample.
export const CAMERA_WHIP_NODE_SAMPLES = 32;

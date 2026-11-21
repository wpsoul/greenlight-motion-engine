// ours: "Clean default" (speedvscycles, the owner's decision 2026-11-16)
// The denoise look a Final trace takes where `rig.render.denoiseLook` (or the player bar's options) leaves it unset: "clean", the
// denoiser's picture alone, with the large network in every render. Natural (a fifth of the traced picture mixed back) left the film's
// 1 s renders grainy beside Cycles' at the same samples; it stays one click away, and a Scene that sets it keeps it. Only the unset value
// changed: nothing stored is rewritten. A plain module (no three), so the editor, the Render dialog, the render page and the 3D player read
// the same default.

/** The looks, in the order the editor offers them. */
export const DENOISE_LOOKS = Object.freeze(['natural', 'clean', 'raw']);

/** The look of a trace that does not say. */
export const DENOISE_LOOK_DEFAULT = 'clean';

/** The look a trace takes: its own when it is one, else the default. */
export const denoiseLookOf = (look) => (DENOISE_LOOKS.includes(look) ? look : DENOISE_LOOK_DEFAULT);

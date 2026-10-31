// The size 3D Text letters are traced and built at, px (text3dGlyphs.js). A mesh
// draws a glyph at font size F with scale F / GLYPH_RASTER_PX. Its own module so
// the 2D text code (layerMesh.js) can place letters without pulling the geometry
// builder — which lives in the lazily loaded 3D chunk — into the editor bundle.
export const GLYPH_RASTER_PX = 160;

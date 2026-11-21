// (screensharp) Where an object's finished geometry is kept between the editor's load and the world's build: the editor reads each
// object's `mesh` (a file and byte ranges) and hands the arrays over (host.setBaked); the world looks them up again when it builds.
// The key is the geometry's place in its file, not the object's `baked` name: every Blender conversion names its meshes m0_0,
// m1_0, …, so two converted models in one Scene shared those names and both drew the first model's meshes. Objects that read the same
// bytes at the same matrix (copies scattered by one placements list) still share one load. A `baked` object with no file (a model layer's shape, the
// Rig's backdrop: arrays the editor made itself) keeps its name. A plain module: the editor and the world import the same function.

const range = (r) => (Array.isArray(r) ? `${r[0]}+${r[1]}` : '-');

/** The store key of an object's geometry, or null when it has none to look up. */
export function meshStoreKey(o) {
  const m = o?.mesh;
  if (m && typeof m.url === 'string' && m.url) {
    // the editor stands the arrays at the object's own `matrix` as it loads them (world3dLayer loadMeshFile): two objects that read the same
    // bytes at two matrices (a part copied and moved) are two loads
    const at = m.placements ? '' : Array.isArray(o.matrix) ? o.matrix.join(',') : '';
    return `file:${m.url}|${range(m.position)}|${range(m.normal)}|${range(m.uv)}|${range(m.index)}|${m.indexType || ''}|${range(m.placements)}|${at}`;
  }
  return o?.baked ? String(o.baked) : null;
}

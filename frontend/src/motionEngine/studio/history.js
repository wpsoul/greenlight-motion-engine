// Undo / Redo for the phone layout (no keyboard there): the page's changes as a list of states, one per finished edit
// (a drag or a typed word is one, SETTLE_MS after it ends). A state is the film under the page, plus the changes over it:
// a rebuild (Add, Duplicate, Delete) bakes the changes into a new film, so going back over one puts the earlier film on
// the page again, through a rebuild, so a card's own log follows (rv:before-rebuild, rv:rebuilt). Another source's film on
// the page starts the list anew. chat.js has the buttons.
const LIMIT = 50, SETTLE_MS = 600;
const differs = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].find((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

export function createHistory(onChange = () => {}) {
  const films = new Map();   // rev → the project of the states that sit on it
  let list = [], at = -1, rev = 0, nextRev = 1, timer = null, busy = false, baking = false;
  const page = () => window.GreenLightMotion && window.GreenLightMotion.page;
  const read = () => {
    const pg = page();
    return pg && pg.ready && pg.editState ? JSON.stringify({ ...pg.editState(), ...(window.LabEdit ? window.LabEdit.marks() : {}) }) : null;
  };
  function start() {
    clearTimeout(timer); timer = null; films.clear();
    rev = nextRev++; films.set(rev, window.GL_LAB_PROJECT);
    list = [{ rev, state: read() }]; at = 0;
    onChange();
  }
  function push(state) {
    list.length = at + 1;
    list.push({ rev, state });
    if (list.length > LIMIT) list.shift();
    at = list.length - 1;
    for (const k of films.keys()) if (!list.some((s) => s.rev === k)) films.delete(k);
    onChange();
  }
  function commit() {
    clearTimeout(timer); timer = null;
    if (baking && !(window.LabEdit && window.LabEdit.rebuilding())) baking = false;   // that rebuild failed
    if (busy || baking || at < 0) return;
    const state = read();
    if (state && state !== list[at].state) push(state); else onChange();
  }
  function note() {
    if (busy || baking || at < 0) return;
    clearTimeout(timer); timer = setTimeout(commit, SETTLE_MS);
    onChange();
  }
  // the toast's word: the layer the step changed
  function what(a, b) {
    if (a.rev !== b.rev) return 'layers';
    const x = JSON.parse(a.state), y = JSON.parse(b.state), id = differs(x.itemEdits, y.itemEdits) || differs(x.timing.items, y.timing.items);
    return (id && (page().layers().find((l) => l.id === id) || {}).name) || '';
  }
  async function go(i) {
    commit();
    if (busy || i < 0 || i >= list.length || (window.LabEdit && window.LabEdit.rebuilding())) return null;
    const from = list[at], to = list[i], film = films.get(to.rev);
    busy = true;
    try {
      if (to.rev !== rev) {
        await window.LabEdit.rebuild((p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, structuredClone(film)); return null; });
        rev = to.rev;
      }
      const state = JSON.parse(to.state);
      page().setEditState(state);
      window.LabEdit.setMarks(state);
      at = i;
      return { word: what(from, to) };
    } finally { busy = false; onChange(); }
  }
  window.addEventListener('glm:edits', note);
  window.addEventListener('rv:before-rebuild', () => { if (busy) return; commit(); baking = true; });
  window.addEventListener('rv:rebuilt', (e) => {
    if (busy) return;
    baking = false; rev = nextRev++; films.set(rev, e.detail.after);
    push(read());
  });
  window.addEventListener('rv:remount', () => { if (!busy && !baking) setTimeout(start, 0); });
  return {
    start,
    undo: () => go(at - 1),
    redo: () => go(at + 1),
    canUndo: () => at > 0 || timer != null,
    canRedo: () => at < list.length - 1 && timer == null,
  };
}

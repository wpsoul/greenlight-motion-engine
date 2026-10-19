// Compact UI for the WEB build on small screens (phones, narrow tablets).
//
// Never active in Electron: the desktop keeps its layout byte for byte. On the
// web the header collapses (view dropdown + overflow menu), the card toolbar
// goes full-width, and the canvas uses the touch LOD thresholds that were tuned
// on real phones for shared boards. `body.gl-compact` mirrors the state for CSS.
import { useEffect, useState } from "react";
import { isElectron } from "./runtime.js";

const COMPACT_QUERY = "(max-width: 900px)";
let mq = null;
let compact = false;
let installed = false;

function canQuery() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && !isElectron();
}

// Coarse pointer on the web: phones and tablets. Drives the LOD thresholds.
export function isTouchWeb() {
  return canQuery() && window.matchMedia("(pointer: coarse)").matches;
}

export function isCompactUi() {
  if (!canQuery()) return false;
  if (!mq) mq = window.matchMedia(COMPACT_QUERY);
  return mq.matches;
}

// One listener for the whole app: keeps `compact` and the body class current.
export function installCompactUi() {
  if (installed || !canQuery()) return;
  installed = true;
  mq = mq || window.matchMedia(COMPACT_QUERY);
  // `gl-touch` marks a coarse pointer for CSS (App.css drops live iframes out of
  // the layer while the canvas moves). Web only, like everything in here.
  if (isTouchWeb()) {
    document.body.classList.add("gl-touch");
    installNoSearchAutofocus();
  }
  const apply = () => {
    compact = mq.matches;
    document.body.classList.toggle("gl-compact", compact);
    window.dispatchEvent(new CustomEvent("gl:compact-change", { detail: { compact } }));
  };
  apply();
  mq.addEventListener("change", apply);
}

// Touch web: modals and pickers focus their search box as they open (autoFocus,
// or a focus() in an effect). On a phone or tablet that throws the keyboard up
// over the thing the user just opened. A search box keeps focus only when the
// finger actually landed on it; any other focus it receives is dropped again.
// Scoped to search / filter inputs so inline editing (tap a name, type) and
// forms are untouched.
const SEARCH_INPUT = 'input[type="search"], input[placeholder*="earch"], input[placeholder*="ilter"], input[aria-label*="earch"]';
function installNoSearchAutofocus() {
  let lastDown = { el: null, t: 0 };
  document.addEventListener("pointerdown", (e) => { lastDown = { el: e.target, t: performance.now() }; }, true);
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (!el || !el.matches || !el.matches(SEARCH_INPUT)) return;
    const d = lastDown.el;
    const fromTap = d && performance.now() - lastDown.t < 800
      && (d === el || el.contains(d) || (d.closest && d.closest("label") && d.closest("label").control === el));
    if (!fromTap) el.blur();
  }, true);
}

export function useCompactUi() {
  const [value, setValue] = useState(() => isCompactUi());
  useEffect(() => {
    if (!canQuery()) return undefined;
    installCompactUi();
    const on = (e) => setValue(Boolean(e.detail?.compact));
    window.addEventListener("gl:compact-change", on);
    setValue(isCompactUi());
    return () => window.removeEventListener("gl:compact-change", on);
  }, []);
  return value;
}

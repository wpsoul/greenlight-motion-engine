import { useEffect, useState } from "react";

// Global app preferences (feature toggles in the App Settings gear menu).
// Stored as one JSON blob in localStorage, mirrored to the Electron settings
// store so they survive localStorage clears. Toggles apply immediately:
// setAppPref dispatches "gl:app-prefs-changed" and useAppPref re-renders.

const PREFS_KEY = "gl_app_prefs";
const PREFS_EVENT = "gl:app-prefs-changed";

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

// Electron settings are async; hydrate localStorage from them once at startup
// so getAppPref stays synchronous everywhere.
let hydrated = false;
export function hydrateAppPrefs() {
  if (hydrated || !window.electronAPI?.getSettings) return;
  hydrated = true;
  window.electronAPI
    .getSettings(PREFS_KEY)
    .then((stored) => {
      if (!stored || typeof stored !== "object") return;
      const merged = { ...stored, ...readPrefs() };
      localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
      window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { key: null } }));
    })
    .catch(() => {});
}

export function getAppPref(key, defaultValue) {
  const prefs = readPrefs();
  return Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : defaultValue;
}

export function setAppPref(key, value) {
  const prefs = { ...readPrefs(), [key]: value };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  window.electronAPI?.setSettings?.(PREFS_KEY, prefs)?.catch?.(() => {});
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { key, value } }));
}

export function useAppPref(key, defaultValue) {
  const [value, setValue] = useState(() => getAppPref(key, defaultValue));
  useEffect(() => {
    const sync = () => setValue(getAppPref(key, defaultValue));
    window.addEventListener(PREFS_EVENT, sync);
    return () => window.removeEventListener(PREFS_EVENT, sync);
  }, [key, defaultValue]);
  return value;
}

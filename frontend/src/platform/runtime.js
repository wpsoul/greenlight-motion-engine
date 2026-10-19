// Runtime/platform detection for GreenLight Dash.
//
// Three runtimes share this frontend:
//   electron   — window.electronAPI present; nothing here changes for it.
//   browser    — plain browser against a desktop-mode backend (dev at :5173).
//   selfhosted — GreenLight Dash Server: /api/auth/bootstrap answers 200 with
//                loginRequired, the session cookie authenticates the browser and
//                unsafe requests must carry the X-GL-CSRF header.
//
// Detection happens once at boot (ensureRuntime). In Electron no request is made.

const state = {
  kind: null,            // 'electron' | 'browser' | 'selfhosted'
  loginRequired: false,
  csrf: null,
  authenticated: false,
  runtimeInfo: null,     // /api/runtime payload once authenticated
  ready: null,           // Promise
};

// `?.`: plain Node (the engine modules' `node --test` suites import this through compact.js) has no import.meta.env
const API = import.meta.env?.VITE_API_BASE_URL || "/api";

export function isElectron() {
  return typeof window !== "undefined" && Boolean(window.electronAPI?.isElectron);
}

export function isSelfHosted() {
  return state.kind === "selfhosted";
}

export function getRuntime() {
  return state;
}

export function getCsrfToken() {
  return state.csrf;
}

function sameOriginApiOrMedia(input) {
  let url;
  try {
    url = new URL(typeof input === "string" ? input : input?.url || "", window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/");
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
let interceptorInstalled = false;

// Central transport for selfhosted mode: every same-origin /api and /media request
// — client.js and the raw fetch() sites alike — gets the CSRF header on unsafe
// methods, and a 401 raises gl:auth-required so the login gate can re-authenticate
// without unmounting the editor. Never touches cross-origin requests.
function installFetchInterceptor() {
  if (interceptorInstalled || typeof window === "undefined") return;
  interceptorInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (!sameOriginApiOrMedia(input)) return nativeFetch(input, init);
    const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    let nextInit = init;
    if (UNSAFE.has(method) && state.csrf) {
      const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
      if (!headers.has("x-gl-csrf")) headers.set("X-GL-CSRF", state.csrf);
      nextInit = { ...(init || {}), headers };
    }
    const res = await nativeFetch(input, nextInit);
    if (res.status === 401 && !String(typeof input === "string" ? input : input?.url).includes("/api/auth/")) {
      state.authenticated = false;
      window.dispatchEvent(new CustomEvent("gl:auth-required"));
    }
    return res;
  };
}

async function fetchSession() {
  const res = await fetch(`${API}/auth/session`, { credentials: "same-origin" });
  if (res.status !== 200) return false;
  const data = await res.json().catch(() => ({}));
  state.csrf = data.csrf || null;
  state.authenticated = true;
  return true;
}

export async function loadRuntimeInfo() {
  try {
    const res = await fetch(`${API}/runtime`, { credentials: "same-origin" });
    if (res.status === 200) state.runtimeInfo = await res.json();
  } catch {
    /* keep the last known value */
  }
  return state.runtimeInfo;
}

export function ensureRuntime() {
  if (state.ready) return state.ready;
  state.ready = (async () => {
    if (isElectron()) {
      state.kind = "electron";
      return state;
    }
    try {
      const res = await fetch(`${API}/auth/bootstrap`, { credentials: "same-origin" });
      if (res.status === 200) {
        const data = await res.json();
        state.kind = "selfhosted";
        state.loginRequired = Boolean(data.loginRequired);
        installFetchInterceptor();
        if (state.loginRequired) {
          const ok = await fetchSession();
          if (ok) await loadRuntimeInfo();
        }
        return state;
      }
    } catch {
      /* backend not up yet or not selfhosted */
    }
    state.kind = "browser";
    return state;
  })();
  return state.ready;
}

export async function login(password) {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status === 429) throw new Error("Too many attempts. Try again in a few minutes.");
  if (res.status === 403) throw new Error("Login refused: origin mismatch. Open the server through its configured URL.");
  if (!res.ok) throw new Error("Wrong password.");
  const data = await res.json();
  state.csrf = data.csrf || null;
  state.authenticated = true;
  await loadRuntimeInfo();
  return true;
}

export async function logout() {
  try {
    await fetch(`${API}/auth/logout`, { method: "POST", credentials: "same-origin" });
  } finally {
    state.csrf = null;
    state.authenticated = false;
    state.runtimeInfo = null;
  }
}

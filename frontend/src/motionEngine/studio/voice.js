/* The mic for the studio's note boxes (a note, a comment on it, a highlight's note).
   Inside GreenLight Dash — a review card, whose page carries RV_DATA.app — the take goes to the app's own transcription
   (/api/ai/transcribe), decided the way the app's own mics decide (hooks/useVoiceInput voicePlan): the on-device speech
   model first (backend/local_stt.py), else the user's OpenAI or WaveSpeed key; with neither it says where to get one
   instead of recording (a card can't open the app's setup window). Anywhere else — a chat's page, a shared link — the browser's own speech recognition, which needs
   nothing set up. With neither, no mic. The words go in after what's typed, through an input event, so the box's own
   handler keeps them. Recording: red and pulsing; writing it in: a spinner (the app's mic, hooks/useVoiceInput). */

const MIC = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';

// '' = the app on this same origin, a URL = the app from a card opened as a file, null = not in the app
const appBase = () => {
  const d = window.RV_DATA;
  if (!d || !d.app) return null;
  return location.protocol === 'file:' ? String(d.app).replace(/\/+$/, '') : '';
};
const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;

function writeIn(box, said) {
  const cur = box.value;
  box.value = cur.trim() ? `${cur.replace(/\s+$/, '')} ${said}` : said;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

// What the app does with a take ('local' | 'cloud'), or why it can't ('setup' | 'keys'); an app without /local-stt
// (an older one) has only the key.
async function appPlan(base, f) {
  const st = await f(`${base}/api/local-stt/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!st) {
    const keys = await f(`${base}/api/keys/status`).then((r) => r.json()).catch(() => null);
    return keys && keys.hasTranscribeKeys === false ? 'keys' : 'cloud';
  }
  // App settings ▸ Speech ▸ Voice input (engines.voice); captions have their own choice, which a mic doesn't use
  const voice = st.engines && st.engines.voice;
  if (st.ready && (voice !== 'cloud' || !st.cloudKeys)) return 'local';
  if (voice === 'cloud' && st.cloudKeys) return 'cloud';
  if (st.available) return 'setup';
  return st.cloudKeys ? 'cloud' : 'keys';
}

// the app's transcription: record a take, send it when stopped
async function viaApp(base) {
  const f = window.RV_FETCH || window.fetch.bind(window);
  const plan = await appPlan(base, f);
  if (plan === 'setup') throw new Error('Voice input: get the free speech model in GreenLight Dash ▸ App settings ▸ Speech, or add an OpenAI or WaveSpeed key.');
  if (plan === 'keys') throw new Error('Voice input needs an OpenAI or WaveSpeed key: add one in GreenLight Dash ▸ Settings.');
  // the model loads while the user talks
  if (plan === 'local') f(`${base}/api/local-stt/warm-up`, { method: 'POST' }).catch(() => {});
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const rec = new MediaRecorder(stream, { mimeType: type });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => {
    rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); resolve(new Blob(chunks, { type: 'audio/webm' })); };
  });
  rec.start();
  return {
    async stop() {
      if (rec.state === 'recording') rec.stop();
      const blob = await done;
      if (blob.size < 100) return '';
      const form = new FormData();
      form.append('file', blob, 'recording.webm');
      const r = await f(`${base}/api/ai/transcribe`, { method: 'POST', body: form });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Transcription failed');
      return String((await r.json()).text || '').trim();
    },
  };
}

// the browser's speech recognition: words as they are heard; it may end by itself after a silence
function viaBrowser(onEnd) {
  const R = Recognition();
  const rec = new R();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = false;
  let text = '', error = null, over = false;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i += 1) if (e.results[i].isFinal) text += `${e.results[i][0].transcript} `;
  };
  rec.onerror = (e) => { error = e.error; };
  const ended = new Promise((resolve) => { rec.onend = () => { over = true; resolve(); onEnd(); }; });
  rec.start();
  return {
    async stop() {
      if (!over) rec.stop();
      await ended;
      if (error && error !== 'no-speech' && error !== 'aborted') throw new Error(error === 'not-allowed' ? 'Microphone access denied' : `Voice input stopped (${error})`);
      return text.trim();
    },
  };
}

// The one take being recorded or written in. It outlives its button: the studio re-renders its panels on many actions,
// so a new mic for the same box (the same `key`) takes it over and the words go into the new box.
let live = null; // { key, take, box, btn, busy }

const show = (b, state) => {
  if (!b) return;
  b.classList.toggle('recording', state === 'recording');
  b.classList.toggle('busy', state === 'busy');
  b.setAttribute('aria-pressed', String(state === 'recording'));
  b.disabled = state === 'busy';
  const t = state === 'recording' ? 'Stop recording' : state === 'busy' ? 'Transcribing…' : 'Voice input';
  b.title = t;
  b.setAttribute('aria-label', t);
};

async function finish(onError) {
  const L = live;
  if (!L || L.busy || !L.take) return; // still starting: the take isn't there yet
  L.busy = true;
  show(L.btn, 'busy');
  try {
    const said = await L.take.stop();
    if (said) writeIn(L.box, said);
  } catch (err) {
    onError(err.message || 'Transcription failed');
  } finally {
    if (live === L) live = null;
    show(L.btn, 'idle');
  }
}

/** A mic for `box`, or null where nothing can write a take in. `key` names the box across re-renders;
    `onError(text)` shows what went wrong. */
export function micButton(box, { key = 'note', onError = () => {}, className = '' } = {}) {
  const base = appBase();
  if (base == null && !Recognition()) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `glm-mic ${className}`.trim();
  b.innerHTML = MIC;
  b.dataset.act = 'mic';
  show(b, 'idle');
  if (live && live.key === key) { live.box = box; live.btn = b; show(b, live.busy ? 'busy' : 'recording'); }
  b.addEventListener('mousedown', (e) => e.preventDefault()); // the caret stays in the box
  b.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (live && live.key === key) { finish(onError); return; }
    if (live) await finish(onError); // another box was recording: its words go in first
    const L = { key, box, btn: b, busy: false, take: null };
    live = L;
    try {
      L.take = base != null ? await viaApp(base) : viaBrowser(() => { if (live === L && !L.busy) finish(onError); });
      if (live === L) show(L.btn, 'recording');
    } catch (err) {
      if (live === L) live = null;
      show(L.btn, 'idle');
      onError(err && err.name === 'NotAllowedError' ? 'Microphone access denied' : (err && err.message) || 'Voice input failed');
    }
  });
  return b;
}

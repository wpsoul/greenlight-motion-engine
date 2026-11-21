/*
 * (chatfarm2) The Render pane's "where to render" — option A of the chat render lab (owner, 2026-11-18): This computer · ≈ time · busy |
 * <farm> · ≈ time · ≈ $, one button that follows the pick; full screen adds the GPU rows (live price, stock, this video's time + cost), the
 * pod count (1–10, picked so the job ends in a few minutes) and the cap. Shown only when a host registered a farm
 * (GreenLightMotion.setRenderFarm: the chat page's RunPod adapter) AND this computer would need more than FARM_LIMITS.warnSec; a short
 * render keeps the pane as it always was. The farm renders picture-only parts; this page renders the sound once and joins them
 * (joinParts), then saves like any render.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { estimateHere, planFarm, farmChoice, podsLine, podsEnded, FARM_LIMITS } from './farmPlan';
import { joinParts, partRanges } from './joinParts';

// ── the host's farm adapter (one per page) ──────────────────────────────────────────────────────────────────────────────────────────
let farm = null;
const subs = new Set();
// the last estimate of this computer's time (the pane's probe), for a host that renders without a press (the chat's render_video)
let lastEstimate = null;
export const farmEstimate = () => lastEstimate;
export function setRenderFarm(adapter) { farm = adapter || null; subs.forEach((f) => f()); }
export const useFarm = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => farm);

const mins = (s) => (!Number.isFinite(s) ? '—' : s < 60 ? `≈ ${Math.max(1, Math.round(s))} s` : s < 3600 ? `≈ ${Math.round(s / 60)} min` : `≈ ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
const usd = (v) => (v < 0.995 ? `$${v.toFixed(2)}` : `$${v.toFixed(2)}`);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const Dot = ({ tone }) => <i className={`cf-dot is-${tone}`} />;

/**
 * props: project, frames, fps, duration, mode ('final' | 'draft' | null), spp, title, full, probe(t) → ms, renderHere(), here (the page's
 * own render state), exportProject(), renderAudio() → bytes, saveFile(blob, name), icons, onBusy(bool)
 */
export function FarmPane({ project, frames, fps, mode, spp, pixels, title, full, probe, renderHere, here, hereProgress, stopHere, exportProject, renderAudio, saveFile, icons, children }) {
  const host = useFarm();
  const [est, setEst] = useState(null);        // this computer: { sec, low, high } (a probe)
  const [probing, setProbing] = useState(false);
  const [cat, setCat] = useState(null);         // the farm's catalog { gpus, startSec }
  const [pickUser, setPick] = useState(null);   // the user's own pick: 'here' | 'pod' (null: the default, farmChoice)
  const [gpuId, setGpuId] = useState(null);
  const [pods, setPods] = useState(null);       // the user's own count (null: the plan's)
  const [view, setView] = useState('choose');   // choose | key | info | starting | pod | done | failed
  const [job, setJob] = useState(null);         // { frames, total, usd, etaSec, pods, startedAt }
  const [fail, setFail] = useState(null);       // { code, message, usd }
  const [receipt, setReceipt] = useState(null);
  const [left, setLeft] = useState([]);         // leftover pods (the sweep)
  const [key, setKey] = useState('');
  const [keyMsg, setKeyMsg] = useState(null);
  const runRef = useRef(null);
  const sig = `${frames}|${fps}|${mode}|${spp}`;

  // this computer: 3 frames at 10 / 50 / 90 % (measured −8 … +13 % against the real render); a Draft film's frames are milliseconds
  useEffect(() => {
    if (!host || !frames) return undefined;
    let dead = false;
    setProbing(true);
    (async () => {
      const ms = [];
      let firstMs = 0;
      for (const f of [0.1, 0.5, 0.9]) {
        const t0 = performance.now();
        try { await probe((f * frames) / fps); } catch { /* a frame that fails here fails the render too: the estimate shows none */ }
        const dt = performance.now() - t0;
        if (!ms.length && dt > 0) firstMs = dt;   // the first carries the page's shader compile
        ms.push(dt);
      }
      if (dead) return;
      const steady = ms.length > 1 ? ms.slice(1) : ms;
      const e = estimateHere({ frames, probeMs: steady, firstMs: Math.max(0, firstMs - (steady[0] || 0)) });
      lastEstimate = e ? { ...e, sig, at: Date.now(), long: e.sec >= FARM_LIMITS.warnSec } : null;
      setEst(e);
      setProbing(false);
    })();
    return () => { dead = true; };
  }, [host, sig]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!host) return undefined;
    let dead = false;
    const load = () => host.catalog().then((c) => { if (!dead) setCat(c); }, () => {});
    load();
    const id = setInterval(load, 60000);
    host.leftovers?.().then((l) => { if (!dead) setLeft(l || []); }, () => {});
    return () => { dead = true; clearInterval(id); };
  }, [host, host?.connected?.()]);   // eslint-disable-line react-hooks/exhaustive-deps

  const plan = useMemo(() => (cat && frames ? planFarm({ frames, fps, spp, pixels, mode: mode || 'draft', gpus: cat.gpus, startSec: cat.startSec, pods }) : null), [cat, frames, fps, spp, pixels, mode, pods]);
  // every long render shows both cards (the farm's time honest, also when slower); ≥ 25 % sooner only makes the farm the default pick
  // (the real 3 s job planned "≈ 4 min | ≈ 4 min" and took 4:51 on the pods). No host, or no GPU in stock: the plain pane, still saying busy
  const choice = farmChoice({ here: est, plan, gpuId, hasHost: !!host });
  const row = choice.row;
  const pick = pickUser || choice.defaultPick;

  if (!host || (!choice.offer && view === 'choose' && !left.length)) {
    return children({ estimate: est, probing });
  }
  const connected = host.connected();
  const name = host.name || 'GPU farm';
  // (0.5.5) the cap shown is the cap the farm enforces (a host may hold a lower one: a test budget); a job shows its own from its events
  const capUsd = plan ? (host.limitCap ? host.limitCap(plan.capUsd) : plan.capUsd) : null;

  async function start() {
    if (!connected) { setView('key'); host.requestFull?.(); return; }
    setView('starting');
    setFail(null);
    const exp = await exportProject();
    const parts = partRanges(frames, fps, row.pods);
    const startedAt = Date.now();
    // (0.5.5) `planned`: the pods this job starts (one a part), what its line says from the first second to the last
    setJob({ frames: 0, total: frames, usd: 0, pods: [], planned: parts.length, startedAt, phase: 'starting', capUsd, gpu: row.name });
    runRef.current = host.run({ project: exp.project, parts, fps, gpuId: row.gpuId, capUsd, onEvent: async (e) => {
      if (e.type === 'progress') { setView('pod'); setJob((j) => ({ ...j, ...e, phase: 'rendering' })); }
      else if (e.type === 'starting') setJob((j) => ({ ...j, ...e, phase: 'starting' }));
      else if (e.type === 'failed') { setFail(e); setView('failed'); }
      else if (e.type === 'parts') {
        setJob((j) => ({ ...j, phase: 'joining', usd: e.usd }));
        try {
          const sound = await renderAudio();
          const joined = await joinParts(e.parts, { sound });
          if (!joined.bytes) throw new Error(joined.report.refused);
          const fileName = `${String(title || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video'}.mp4`;
          await saveFile(new Blob([joined.bytes], { type: 'video/mp4' }), fileName);
          setReceipt({ fileName, bytes: joined.bytes.length, sec: (Date.now() - startedAt) / 1000, usd: e.usd, capUsd: e.capUsd ?? capUsd, here: est?.sec, pods: podsEnded(e), sound: sound ? 'AAC' : 'none' });
          setView('done');
        } catch (err) { setFail({ code: 'JOIN', message: String(err?.message || err), usd: e.usd }); setView('failed'); }
      }
    } });
  }
  const stop = () => { runRef.current?.stop(); setFail({ code: 'STOPPED', message: 'Stopped', usd: job?.usd || 0 }); setView('failed'); };

  // ── the views (the lab's option A, made of the pane's own parts) ──
  const head = (t, s) => ({ title: t, sub: s });
  let h = head('Render', `${title} · ${Math.round((frames / fps) * 10) / 10} s · ${mode === 'final' ? `Final ${spp} spp` : 'Draft'}`);
  let body = null;
  if (left.length && view === 'choose') {
    const rate = left.reduce((s, p) => s + (p.usdPerHr || 0), 0);
    body = (<section className="glm-sec"><h3 className="glm-h">Pod left on <span>from an earlier render</span></h3>
      <div className="glm-warn cf-warn-in"><Dot tone="warn" /><span><b>{left.length} {name} pod{left.length > 1 ? 's' : ''} still on</b> · ${rate.toFixed(2)}/h</span></div>
      <div className="cf-two"><button type="button" className="glm-btn" onClick={() => setLeft([])}>Keep</button>
        <button type="button" className="glm-go cf-go-sm" onClick={async () => { await host.endPods(left.map((p) => p.id)); setLeft([]); }}>{icons.stop}End it · stop billing</button></div></section>);
  } else if (view === 'key') {
    h = head(`Connect ${name}`, 'Only for this page');
    body = (<section className="glm-sec"><h3 className="glm-h">Your {name} key</h3>
      {full && <ol className="cf-steps"><li>{name} ▸ Settings ▸ API Keys</li><li>Create key · Read/Write</li><li>Paste it here</li></ol>}
      <div className="cf-keyrow"><input className="glm-in" type="password" autoComplete="off" spellCheck="false" placeholder="rpa_…" aria-label={`${name} key`} value={key} onChange={(e) => setKey(e.target.value)} />
        <button type="button" className="glm-btn" onClick={async () => { setKeyMsg({ tone: '', text: 'Testing…' }); const r = await host.connect(key.trim()); setKeyMsg(r.ok ? { tone: 'good', text: r.message } : { tone: 'bad', text: r.message }); if (r.ok) { setKey(''); host.catalog().then(setCat, () => {}); } }}>Test</button></div>
      {keyMsg ? <p className={`glm-status is-${keyMsg.tone || 'plain'}`}>{keyMsg.tone && <Dot tone={keyMsg.tone === 'good' ? 'good' : 'bad'} />}{keyMsg.text}</p>
        : !full && <p className="glm-status">{name} ▸ Settings ▸ API Keys · Read/Write</p>}
      {full && <p className="glm-status">Asked again when this page reopens</p>}
      <button type="button" className="glm-go" disabled={!host.connected()} onClick={() => { setView('choose'); start(); }}>{icons.film}Render on {name}{row ? ` · ≈ ${usd(row.usd)}` : ''}</button></section>);
  } else if (view === 'info') {
    h = head(`How ${name} works`, 'Your GPU, your account');
    body = (<section className="glm-sec"><ul className={`cf-points${full ? '' : ' cf-points-sm'}`}>
      <li>{icons.cloud}<div><b>Your own GPU</b><span>This computer stays free.</span></div></li>
      <li>{icons.info}<div><b>Straight to {name}</b><span>Your key goes only to {name}; the film and your files go straight to your pods. Nothing passes GreenLight.</span></div></li>
      <li>{icons.stop}<div><b>Ends itself</b><span>When its part is here, on Stop, or after 10 idle minutes.</span></div></li>
      {full && <li><Dot tone="warn" /><div><b>Billed by {name}</b><span>Per second, from start to end. The estimate counts the ≈ 2-minute start.</span></div></li>}</ul>
      <button type="button" className="glm-btn" onClick={() => setView('choose')}>Back</button></section>);
  } else if (view === 'starting' || view === 'pod') {
    h = head(`Render on ${name}`, podsLine(job, row, view));
    const el = job ? (Date.now() - job.startedAt) / 1000 : 0;
    const p = job?.total ? job.frames / job.total : 0;
    body = view === 'starting'
      ? (<section className="glm-sec"><h3 className="glm-h">Starting pods <span>{clock(el)} of ≈ {clock(cat?.startSec || 120)}</span></h3>
        <div className="glm-progress" role="status"><div className="glm-pbar"><span style={{ transform: `scaleX(${Math.min(0.95, el / (cat?.startSec || 120))})` }} /></div>
          <div className="glm-prow"><span>{job?.planned ? `Starting ${job.planned} pod${job.planned > 1 ? 's' : ''}${job.pods?.length ? ` · ${job.pods.length} of ${job.planned} up` : ''}` : 'Then the film goes to the pods'}</span><button type="button" className="glm-btn" onClick={stop}>Stop</button></div></div>
        <p className="glm-status cf-amber"><Dot tone="warn" />Keep this chat open</p></section>)
      : (<section className="glm-sec"><h3 className="glm-h">Rendering <span>{job.frames} of {job.total} frames</span></h3>
        <div className="glm-progress" role="status"><div className="glm-pbar"><span style={{ transform: `scaleX(${p})` }} /></div>
          <div className="glm-prow"><span>{job.etaSec ? `${mins(job.etaSec).replace('≈ ', '')} left · ` : ''}{usd(job.usd || 0)} so far</span><button type="button" className="glm-btn" onClick={stop}>Stop</button></div>
          <div className="glm-prow cf-sub"><span>Stops at {usd(job.capUsd)}</span></div></div>
        <p className="glm-status is-good"><Dot tone="good" />This computer is free · keep this chat open</p></section>);
  } else if (view === 'done' && receipt) {
    h = head('Render', 'Saved to your computer');
    body = (<section className="glm-sec"><h3 className="glm-h">Done <span>{receipt.fileName} · {(receipt.bytes / 1048576).toFixed(1)} MB</span></h3>
      <dl className="cf-receipt"><dt>Time</dt><dd>{clock(receipt.sec)}{receipt.here ? <s>here {mins(receipt.here)}</s> : null}</dd>
        <dt>Cost</dt><dd>{usd(receipt.usd || 0)} <s>cap {usd(receipt.capUsd)}</s></dd>
        <dt>Pods</dt><dd><Dot tone="good" />{receipt.pods} ended · nothing left on</dd></dl>
      <div className="glm-actions"><button type="button" className="glm-btn" onClick={() => setView('choose')}>Done</button></div></section>);
  } else if (view === 'failed' && fail) {
    const noStock = fail.code === 'NO_STOCK';
    h = head(`Render on ${name}`, (fail.usd || 0) > 0 ? `${usd(fail.usd)} spent` : 'Nothing was charged');
    const alt = noStock && plan ? plan.rows.find((r) => r.gpuId !== row?.gpuId && r.stock !== 'NONE') : null;
    body = (<section className="glm-sec"><h3 className="glm-h">{noStock ? 'No GPU free' : fail.code === 'STOPPED' ? 'Stopped' : fail.code === 'CAP' ? 'Stopped at the cap' : 'Pod stopped'} <span>{noStock ? `${row?.name} · every region` : ''}</span></h3>
      <p className="glm-status is-bad"><Dot tone="bad" />{noStock ? `${name} has no ${row?.name} now` : fail.message}</p>
      <div className="cf-two"><button type="button" className="glm-btn" onClick={() => { setView('choose'); renderHere(); }}>Render here</button>
        <button type="button" className="glm-go cf-go-sm" onClick={() => { if (alt) setGpuId(alt.gpuId); setView('choose'); }}>{icons.film}{alt ? `Try ${alt.name} · ≈ ${usd(alt.usd)}` : 'Try again'}</button></div></section>);
  } else if (here) {
    const p = Math.max(0, Math.min(1, Number(hereProgress) || 0));
    const remain = est && p > 0.02 ? est.sec * (1 - p) : est?.sec;
    h = head('Render', `${title} · rendering here`);
    body = (<section className="glm-sec"><h3 className="glm-h">Rendering here <span>{Math.round(p * frames)} of {frames} frames</span></h3>
      <div className="glm-progress" role="status"><div className="glm-pbar"><span style={{ transform: `scaleX(${p})` }} /></div>
        <div className="glm-prow"><span>{remain ? `${mins(remain).replace('≈ ', '')} left` : 'Starting'}</span><button type="button" className="glm-btn" onClick={stopHere}>Stop</button></div></div>
      <p className="glm-status cf-amber"><Dot tone="warn" />Computer busy · keep this chat open</p></section>);
  } else {
    // choose
    const podLabel = !connected ? 'not connected' : null;
    body = (<section className="glm-sec"><h3 className="glm-h">Where to render <span>{full ? `${Math.round(Math.sqrt(pixels * 16 / 9))}×${Math.round(Math.sqrt(pixels * 9 / 16))} · ${frames} frames` : `${fps} fps`}</span></h3>
      <div className="glm-fmts cf-where" role="group" aria-label="Where to render">
        <button type="button" aria-pressed={pick === 'here'} onClick={() => setPick('here')}><b>This computer</b><span>{probing ? 'Measuring…' : mins(est?.sec)} · <em className="cf-busy">busy</em></span></button>
        <button type="button" aria-pressed={pick === 'pod'} onClick={() => setPick('pod')}><b>{name}{podLabel && <small className="cf-tag">{podLabel}</small>}</b><span>{row ? `${mins(row.sec)} · ≈ ${usd(row.usd)}` : 'Prices…'}</span></button>
      </div>
      {full && plan && (<>
        <h3 className="glm-h">GPU <span>Price · stock now</span></h3>
        <div className="cf-gpus" role="radiogroup" aria-label="GPU">{plan.rows.map((r) => (
          <button key={r.gpuId} type="button" role="radio" className="cf-gpu" aria-checked={r.gpuId === row?.gpuId} disabled={r.stock === 'NONE'} onClick={() => setGpuId(r.gpuId)}>
            <span className="cf-gname"><b>{r.name}</b><span className="cf-stock"><Dot tone={!r.stock ? 'plain' : r.stock === 'NONE' ? 'bad' : r.stock === 'LOW' ? 'warn' : 'good'} />{(r.stock || '').toLowerCase() || 'stock after connect'} · ${r.usdPerHr?.toFixed(2)}/h</span></span>
            <span className="cf-num">{mins(r.sec)}</span><span className="cf-num cf-usd">≈ {usd(r.usd)}</span></button>))}</div>
        <h3 className="glm-h">Pods <span>Stops at {usd(capUsd)}</span></h3>
        <div className="cf-podrow"><button type="button" className="glm-btn" aria-label="Fewer pods" onClick={() => setPods((n) => Math.max(1, (n ?? row?.pods ?? 1) - 1))}>−</button>
          <b>{row?.pods} pod{row?.pods > 1 ? 's' : ''}</b><span>{mins(row?.sec)} · ≈ {usd(row?.usd || 0)}</span>
          <button type="button" className="glm-btn" aria-label="More pods" onClick={() => setPods((n) => Math.min(FARM_LIMITS.maxPods, (n ?? row?.pods ?? 1) + 1))}>+</button></div>
      </>)}
      {pick === 'here'
        ? <button type="button" className="glm-go" onClick={renderHere}>{icons.film}Render here · {mins(est?.sec)}</button>
        : <button type="button" className="glm-go" onClick={start}>{connected ? icons.film : icons.cloud}{connected ? `Render on ${name} · ≈ ${usd(row?.usd || 0)}` : `Connect ${name}`}</button>}
    </section>);
  }
  return children({ estimate: est, probing, farm: { head: h, body, info: view === 'choose' ? () => setView('info') : null } });
}

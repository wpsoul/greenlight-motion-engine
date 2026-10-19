/*
 * The review notes' controls (useReview.js has the logic): the tool bar over the preview, the note field that opens
 * on a finished mark (pages outside a Claude artifact; in an artifact the claude.ai comment box takes its place),
 * and the list of notes in the inspector.
 */
import { useEffect, useRef, useState } from 'react';
import { REVIEW_TOOLS, markGeometry } from './reviewNotes';

const ToolIcon = {
  pin: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M8 11.2v3" /></svg>,
  box: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>,
  arrow: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M3 13 12.5 3.5M6.5 3.5h6v6" /></svg>,
  pen: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M2.5 12.5c2-3 3.5-1 5-3.5s2-5 4-5.5 1.6 2 0 3.2" /></svg>,
};
const clockOf = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

export function ReviewBar({ review }) {
  // in an artifact the comment box anchors a point or an area: pins and boxes
  const tools = review.mode === 'comments' ? REVIEW_TOOLS.filter((t) => t.id === 'pin' || t.id === 'box') : REVIEW_TOOLS;
  return (
    <div className="glm-rvbar" role="toolbar" aria-label="Note tools">
      {tools.map((t) => (
        <button key={t.id} type="button" className="glm-rvtool" data-rv-tool={t.id} aria-pressed={review.tool === t.id}
          onClick={() => review.setTool(t.id)} title={`${t.label} (${t.key.toUpperCase()}): ${t.hint}`}>
          {ToolIcon[t.id]}<span>{t.label}</span>
        </button>
      ))}
      <span className="glm-rvhint">
        {review.mode === 'comments'
          ? 'Mark a spot, write your note in the comment box, then press Send to Claude.'
          : 'Mark a spot on the frame, then write what to change.'}
      </span>
      <button type="button" className="glm-rvdone" onClick={() => review.toggle(false)}>Done</button>
    </div>
  );
}

export function NoteComposer({ composer, fit, size, onSave, onCancel }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const p = markGeometry(composer.mark).point;
  const x = fit.x + (p.x / size.w) * size.w * fit.scale;
  const y = fit.y + (p.y / size.h) * size.h * fit.scale;
  const layer = composer.layers[0];
  return (
    <div className="glm-rvnote" role="dialog" aria-label="Note for your agent"
      style={{ left: `clamp(8px, ${x + 14}px, calc(100% - 328px))`, top: `clamp(8px, ${y + 14}px, calc(100% - 170px))` }}
      onPointerDown={(e) => e.stopPropagation()}>
      <p className="glm-rvwhere">{clockOf(composer.t)} · {layer ? <>on <b>{layer.name}</b></> : 'on the background'}</p>
      <textarea ref={ref} rows={3} value={text} placeholder="What should change here?" aria-label="Your note"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(text); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }} />
      <div className="glm-rvrow">
        <button type="button" className="glm-btn is-quiet" onClick={onCancel}>Cancel</button>
        <button type="button" className="glm-btn is-primary" data-rv-save="" onClick={() => onSave(text)}>Add note</button>
      </div>
    </div>
  );
}

export function NotesSection({ review, onJump, onSave, saving }) {
  if (review.mode === 'comments') {
    return (
      <div className="glm-sec glm-rvsec">
        <h3 className="glm-h">Notes for Claude <span>{review.count || ''}</span></h3>
        <p className="glm-sub">Press <b>Notes</b>, mark a spot on the frame and write your note in the comment box. <b>Send to Claude</b> hands it to the agent with the moment and the layer under your mark; the answer comes in the thread.</p>
      </div>
    );
  }
  const list = [...review.notes].sort((a, b) => a.t - b.t || a.n - b.n);
  return (
    <div className="glm-sec glm-rvsec">
      <h3 className="glm-h">Notes for your agent <span>{list.length || ''}</span></h3>
      {list.length === 0 ? (
        <p className="glm-sub">Press <b>Notes</b> and mark what should change, right on the frame: each mark gets your words, the moment and the layer under it.</p>
      ) : (
        <ol className="glm-rvlist">
          {list.map((n) => (
            <li key={n.id} data-note={n.n}>
              <button type="button" className="glm-rvitem" onClick={() => onJump(n)} title="Show this moment">
                <i>{n.n}</i>
                <span><b>{clockOf(n.t)}{n.layers?.[0] ? ` · ${n.layers[0].name}` : ''}</b>{n.text || 'No words, just the mark'}</span>
              </button>
              <button type="button" className="glm-icon" aria-label={`Delete note ${n.n}`} onClick={() => review.remove(n.id)}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="m4 4 8 8M12 4l-8 8" /></svg>
              </button>
            </li>
          ))}
        </ol>
      )}
      {list.length > 0 && review.mode === 'server' && <p className="glm-sub">They are in the project folder, in <b>review/</b>. Tell your agent you left notes.</p>}
      {list.length > 0 && review.mode === 'local' && (
        <div className="glm-actions">
          <button type="button" className="glm-btn" onClick={review.copy}>Copy for agent</button>
          <button type="button" className="glm-btn" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save notes'}</button>
        </div>
      )}
      {review.status && <p className={`glm-status is-${review.status.tone || 'plain'}`} role="status">{review.status.text}</p>}
    </div>
  );
}

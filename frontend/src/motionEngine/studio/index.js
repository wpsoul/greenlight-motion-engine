/*
 * GreenLight Motion Studio — the engine page with the review interface every host shares: the left rail (Sources ·
 * Layers · Project · Keys), the inspector and gizmo, the Navigator, Edit · Notes · Highlight over the preview.
 * The review card on a board, the lab, a chat's page and a shared link all mount THIS (one look, one notes system);
 * a host only says where its sources come from and where a review goes (RV_CONFIG.save).
 *
 *   GreenLightMotion.mountStudio(el, { project, sources?, strips?, parts?, config?, assets? })
 *
 * project  the film on the page (the lab's sample, a card's empty film or a source's project) — window.GL_LAB_PROJECT
 * sources  [{ k, title, sub, col, video?, project?, cuts?, values, layers }] — window.RV_SOURCES (default: one, the project)
 * strips   { [k]: { strip, n, step, tw, th, poster } } filmstrips per source — window.RV_STRIPS
 * parts    [[label, startSeconds, sub]] the film's parts — window.RV_PARTS
 * config   window.RV_CONFIG: { title, modes, start, storeKey, fps, startAt, save(job), saveLabel, canMode, cantMode, onSource, … }
 * assets   the page's files for the engine (mountPage's assets: a map or a function ref → file)
 * A host may set those globals itself before calling (the card does); a host may also write its own left rail
 * (.lab-side) first (the lab, older cards) — otherwise the standard one is built here.
 * One studio per page: its parts listen on the window.
 */
// the studio's look, put on the page only when a studio mounts (a page with the plain engine page keeps its own look)
import labCss from './lab.css?inline';
import notesCss from './notes.css?inline';
import reviewCss from './review.css?inline';
import highlightCss from './highlight.css?inline';
import navigatorCss from './navigator.css?inline';
import colorCss from './color.css?inline';
import focusCss from './focus.css?inline';
import * as sketch from '../../components/sketch/sketchEngine.js';
import { zipStore } from '../reviewNotes.js';
import { install as lab } from './lab.js';
import { install as review } from './review.js';
import { install as color } from './color.js';
import { install as inspector } from './inspector.js';
import { install as gizmo } from './gizmo.js';
import { install as notes } from './notes.js';
import { install as highlight } from './highlight.js';

const SORT_CARET = '<svg class="ve-nav-sort-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const COLLAPSE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 19h16M9 10.5 12 8l3 2.5M9 13.5l3 2.5 3-2.5"/></svg>';
const key = (label, keys) => `<div class="key-row"><span>${label}</span>${keys}</div>`;
const kbd = (...k) => (k.length === 1 ? `<kbd>${k[0]}</kbd>` : `<span>${k.map((x) => `<kbd>${x}</kbd>`).join(' ')}</span>`);

// the standard left rail (what review cards wrote before the studio lived in the engine)
function shell(n) {
  return `<nav class="lab-rail" aria-label="Panels">
<button data-tab="sources" aria-pressed="false"><span data-icon="sources"></span>Sources</button>
<button data-tab="layers" class="active" aria-pressed="true"><span data-icon="layers"></span>Layers</button>
<button data-tab="project" aria-pressed="false" hidden><span data-icon="sliders"></span>Project</button>
<button data-tab="keys" aria-pressed="false"><span data-icon="keys"></span>Keys</button>
</nav>
<div class="lab-pane">
<div class="lab-pane-head"><strong id="pane-title">Layers</strong><small id="layer-count"></small><span id="nav-tools" class="rv-nav-tools" hidden><span class="ve-nav-sort" title="Sort layers"><select id="nav-sort" aria-label="Sort layers"><option value="channel">By Channel</option><option value="type">By Type</option><option value="time60">By Time (1 minute)</option><option value="time10">By Time (10 sec)</option></select>${SORT_CARET}</span><button type="button" id="nav-collapse" class="ve-nav-collapse-all" title="Collapse all">${COLLAPSE}</button></span></div>
<div id="sources-pane" class="lab-pane-body" hidden><div id="source-list" class="rv-srcs"></div></div>
<div id="layers-pane" class="lab-pane-body rv-nav-pane"><div id="layer-list" class="ve-navigator"></div></div>
<div id="project-pane" class="lab-pane-body" hidden><span id="project-sources"></span><button class="lab-button" id="save-project" hidden></button></div>
<div id="keys-pane" class="lab-pane-body" hidden>
<h3 class="rv-keys-h">Playback</h3>
${key('Play / pause', kbd('Space'))}
${key('One frame · ten', kbd('←', '→', 'Shift'))}
<div class="key-row rv-multi"><span>Switch source</span><span><kbd>1</kbd> – <kbd id="keys-last">${n}</kbd></span></div>
${key('Notes', kbd('N'))}
<h3 class="rv-keys-h">Highlight</h3>
${key('In / out at the playhead', kbd('I', 'O'))}
${key('Add highlight · Done', kbd('Enter'))}
${key('Clear · Cancel edit', kbd('Esc'))}
${key('Pick an edge', kbd('[', ']'))}
${key('Nudge the edge · ten', kbd(',', '.', 'Shift'))}
${key('Play the range in a loop', kbd('P'))}
<h3 class="rv-keys-h">Notes</h3>
${key('Pen · Highlighter · Arrow', kbd('P', 'H', 'A'))}
${key('Box · Text · Pin', kbd('R', 'T', 'N'))}
${key('Hide · Crop · Range', kbd('X', 'C', 'G'))}
</div>
</div>`;
}

let mounted = false;
export function mountStudio(el, { project, sources, strips, parts, config, assets = null } = {}) {
  if (!el) throw new Error('GreenLightMotion.mountStudio needs an element');
  if (mounted) throw new Error('GreenLightMotion.mountStudio: one studio per page');
  if (project) window.GL_LAB_PROJECT = project;
  if (!window.GL_LAB_PROJECT) throw new Error('GreenLightMotion.mountStudio needs a project');
  if (sources) window.RV_SOURCES = sources;
  if (strips) window.RV_STRIPS = strips;
  if (parts) window.RV_PARTS = parts;
  if (config) window.RV_CONFIG = config;
  // a page with no host behind it (a shared link, a project folder's page): the film's own name and storage, and the
  // review as text to copy for an agent. (The lab brings its own sources and keeps the lab's defaults.)
  if (!window.RV_CONFIG && !window.RV_SOURCES) {
    const title = window.GL_LAB_PROJECT.template?.title || window.GL_LAB_PROJECT.name || 'Video';
    window.RV_CONFIG = { title, storeKey: 'glm-studio-' + String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40), start: 'edit', startAt: 0,
      saveLabel: 'Copy for agent', saveTitle: 'Your notes, highlights and changes, as text for your agent', savedText: 'Ready to copy',
      copyNote: '<b>Your review.</b> Copy it and give it to your agent with this video.' };
  }
  if (!document.querySelector('.lab-side')) {
    const side = document.createElement('aside');
    side.className = 'lab-side';
    side.setAttribute('aria-label', 'Sources');
    side.hidden = true;
    side.innerHTML = shell((window.RV_SOURCES || []).length || 1);
    el.after(side);
  }
  if (!document.getElementById('lab-toast')) {
    const toast = document.createElement('div');
    toast.id = 'lab-toast';
    toast.setAttribute('role', 'status');
    document.body.append(toast);
  }
  if (!document.querySelector('style[data-greenlight-studio]')) {
    const style = document.createElement('style');
    style.setAttribute('data-greenlight-studio', '');
    style.textContent = [labCss, notesCss, reviewCss, highlightCss, navigatorCss, colorCss, focusCss].join('\n');
    document.head.append(style);
  }
  // Notes draw with the app's own sketch engine
  window.LabNoteEngine = { ...sketch, zipStore };
  const STUDIO = { el, assets };   // assets: the page's files, as mountPage takes them (a chat's .glvideo, the user's own)
  mounted = true;
  // the order the card loaded them in: the page and the rail, the modes, then the parts that use them
  for (const install of [lab, review, color, inspector, gizmo, notes, highlight]) install(STUDIO);
  return STUDIO;
}
